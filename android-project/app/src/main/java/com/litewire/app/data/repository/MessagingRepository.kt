package com.litewire.app.data.repository

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.litewire.app.crypto.CryptoManager
import com.litewire.app.data.local.LiteWireDatabase
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.MessageStatus
import com.litewire.app.data.local.entity.UserEntity
import com.litewire.app.data.remote.FirebaseDataSource
import com.litewire.app.data.remote.RemoteChatMessage
import com.litewire.app.data.remote.RemoteConversation
import com.litewire.app.data.remote.RemoteUser
import com.litewire.app.sync.SyncWorker
import com.litewire.app.util.BandwidthMonitor
import com.litewire.app.util.ConnectivityObserver
import com.litewire.app.util.NetworkType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Single source of truth: Room is the local cache + offline queue, Firestore carries ciphertext only.
 * Long-running sync functions never throw (except cancellation) so they cannot crash a ViewModel scope.
 */
class MessagingRepository(
    private val context: Context,
    private val db: LiteWireDatabase,
    private val remote: FirebaseDataSource,
    private val crypto: CryptoManager,
    val bandwidth: BandwidthMonitor,
    private val connectivity: ConnectivityObserver
) {

    private val sendMutex = Mutex()
    private val ensuredConversations = ConcurrentHashMap.newKeySet<String>()
    private val refreshedPeers = ConcurrentHashMap.newKeySet<String>()
    private val fetchedUpTo = ConcurrentHashMap<String, Long>()
    private val fingerprintCache = ConcurrentHashMap<String, String>()

    // ---------- session ----------

    fun currentUid(): String? = remote.currentUid()

    suspend fun register(username: String, displayName: String, email: String, password: String) {
        val uname = username.trim().removePrefix("@").lowercase()
        require(Regex("^[a-z0-9_]{3,24}$").matches(uname)) {
            "Username must be 3-24 characters: letters a-z, digits and underscore only."
        }
        val name = displayName.trim()
        require(name.length in 1..40) { "Display name must be 1-40 characters." }

        bandwidth.ensureInitialized()
        val uid = remote.createAuthUser(email.trim(), password)
        try {
            val pub = crypto.getOrCreatePublicKeyBase64(uid)
            remote.createProfile(uid, uname, name, pub)
            db.userDao().upsert(UserEntity(uid, uname, name, pub))
            bandwidth.recordOutboundPayload(listOf(uid, uname, name, pub), false)
        } catch (e: Exception) {
            runCatching { remote.deleteCurrentAuthUser() }
            throw e
        }
        runCatching { remote.registerCurrentFcmToken() }
    }

    suspend fun login(email: String, password: String) {
        bandwidth.ensureInitialized()
        val uid = remote.signIn(email.trim(), password)
        val profile = remote.getUser(uid) ?: run {
            remote.signOut()
            throw IllegalStateException("Account profile not found. Please register again.")
        }
        var pub = profile.publicKey
        if (!crypto.hasPrivateKey(uid) || pub.isBlank()) {
            // New device or reinstall: a fresh identity key is needed. Old history can't be decrypted.
            pub = crypto.getOrCreatePublicKeyBase64(uid)
            remote.updatePublicKey(uid, pub)
        }
        db.userDao().upsert(UserEntity(uid, profile.username, profile.displayName, pub))
        bandwidth.recordInboundPayload(
            listOf(uid, profile.username, profile.displayName, profile.publicKey),
            false
        )
        runCatching { remote.setPresence(uid, true) }
        runCatching { remote.registerCurrentFcmToken() }
    }

    suspend fun logout() {
        val uid = currentUid()
        if (uid != null && connectivity.isOnlineNow()) {
            runCatching { remote.setPresence(uid, false) }
        }
        remote.signOut()
        ensuredConversations.clear()
        refreshedPeers.clear()
        fetchedUpTo.clear()
        fingerprintCache.clear()
        runCatching {
            db.messageDao().clear()
            db.conversationDao().clear()
            db.userDao().clear()
        }
    }

    suspend fun getCurrentUserProfile(): UserEntity? {
        val uid = currentUid() ?: return null
        db.userDao().get(uid)?.let { return it }
        return try {
            val r = remote.getUser(uid) ?: return null
            val entity = UserEntity(r.uid, r.username, r.displayName, r.publicKey)
            db.userDao().upsert(entity)
            entity
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    // ---------- observers ----------

    fun observeConversations(): Flow<List<ConversationEntity>> = db.conversationDao().observeAll()

    fun observePendingCount(): Flow<Int> = db.messageDao().observePendingCount()

    fun observeDataMetrics(): Flow<DataMetricEntity> = bandwidth.observeMetrics()

    fun observeNetworkType(): Flow<NetworkType> = connectivity.observeNetworkType()

    fun observeConversation(conversationId: String): Flow<ConversationEntity?> =
        db.conversationDao().observeById(conversationId)

    fun observeMessagesPaged(conversationId: String, limit: Int): Flow<List<MessageEntity>> =
        db.messageDao().observePaged(conversationId, limit)

    // ---------- users & conversations ----------

    suspend fun searchUsers(query: String): List<RemoteUser> {
        val q = query.trim().removePrefix("@").lowercase()
        if (q.length < 2) return emptyList()
        val me = currentUid()
        val results = remote.searchUsers(q).filter { it.uid != me }
        bandwidth.recordOutboundPayload(listOf(q), false)
        bandwidth.recordInboundPayload(
            results.flatMap { listOf(it.uid, it.username, it.displayName, it.publicKey) },
            false
        )
        return results
    }

    suspend fun startOrGetConversation(peer: RemoteUser): String {
        val me = currentUid() ?: throw IllegalStateException("Not signed in.")
        val conversationId = listOf(me, peer.uid).sorted().joinToString("_")
        val dao = db.conversationDao()
        val existing = dao.getById(conversationId)
        if (existing == null) {
            dao.upsert(
                ConversationEntity(
                    conversationId = conversationId,
                    peerUid = peer.uid,
                    peerUsername = peer.username,
                    peerDisplayName = peer.displayName,
                    peerPublicKey = peer.publicKey,
                    peerOnline = peer.online
                )
            )
        } else {
            dao.updatePeer(conversationId, peer.username, peer.displayName, peer.publicKey, peer.online)
        }
        refreshedPeers.add(peer.uid)
        try {
            remote.ensureConversation(conversationId, me, peer.uid)
            ensuredConversations.add(conversationId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline: created lazily on first send.
        }
        return conversationId
    }

    // ---------- sync ----------

    /** Long-running: listens to my conversation list until the calling job is cancelled. */
    suspend fun syncConversationMetadata() {
        val me = currentUid() ?: return
        try {
            remote.observeConversations(me).collect { list ->
                for (rc in list) {
                    try {
                        syncOneConversation(me, rc)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    private suspend fun syncOneConversation(me: String, rc: RemoteConversation) {
        val peerUid = rc.participants.firstOrNull { it != me } ?: return
        val convoDao = db.conversationDao()
        val existing = convoDao.getById(rc.conversationId)

        if (existing == null || !refreshedPeers.contains(peerUid)) {
            val peer = remote.getUser(peerUid)
            if (peer != null) {
                refreshedPeers.add(peerUid)
                if (existing == null) {
                    convoDao.upsert(
                        ConversationEntity(
                            conversationId = rc.conversationId,
                            peerUid = peer.uid,
                            peerUsername = peer.username,
                            peerDisplayName = peer.displayName,
                            peerPublicKey = peer.publicKey,
                            peerOnline = peer.online
                        )
                    )
                } else {
                    convoDao.updatePeer(
                        rc.conversationId, peer.username, peer.displayName, peer.publicKey, peer.online
                    )
                }
            } else if (existing == null) {
                return
            }
        }

        val local = convoDao.getById(rc.conversationId) ?: return
        val alreadyFetched = fetchedUpTo[rc.conversationId] ?: 0L
        if (rc.updatedAt > local.lastMessageTimestamp && rc.updatedAt > alreadyFetched) {
            val recent = remote.fetchRecentMessages(rc.conversationId, 30)
            fetchedUpTo[rc.conversationId] = rc.updatedAt
            recent.sortedBy { it.timestamp }.forEach { processRemoteMessage(me, rc.conversationId, it) }
        }
    }

    /** Long-running: listens to one open chat until the calling job is cancelled. */
    suspend fun syncIncomingMessages(conversationId: String) {
        val me = currentUid() ?: return
        try {
            remote.observeMessages(conversationId).collect { batch ->
                for (m in batch) {
                    try {
                        processRemoteMessage(me, conversationId, m)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    private fun rank(status: MessageStatus): Int = when (status) {
        MessageStatus.PENDING -> 0
        MessageStatus.SENT -> 1
        MessageStatus.DELIVERED -> 2
        MessageStatus.READ -> 3
    }

    private fun statusFromRemote(s: String): MessageStatus = when (s) {
        "READ" -> MessageStatus.READ
        "DELIVERED" -> MessageStatus.DELIVERED
        else -> MessageStatus.SENT
    }

    private suspend fun processRemoteMessage(me: String, conversationId: String, m: RemoteChatMessage) {
        val messageDao = db.messageDao()
        val convo = db.conversationDao().getById(conversationId) ?: return
        val isMine = m.senderId == me
        val remoteStatus = statusFromRemote(m.status)
        val existing = messageDao.getById(m.messageId)

        if (existing != null) {
            // Only receipts for my own messages can change after insertion.
            if (isMine && rank(remoteStatus) > rank(existing.status)) {
                messageDao.updateStatus(m.messageId, remoteStatus)
            }
            return
        }

        val text = runCatching {
            crypto.decrypt(me, convo.peerPublicKey, conversationId, m.ciphertext, m.iv)
        }.getOrElse { "\uD83D\uDD12 Unable to decrypt this message" }

        val localStatus = if (isMine) {
            if (rank(remoteStatus) < rank(MessageStatus.SENT)) MessageStatus.SENT else remoteStatus
        } else {
            if (remoteStatus == MessageStatus.READ) MessageStatus.READ else MessageStatus.DELIVERED
        }

        messageDao.insertIfAbsent(
            MessageEntity(
                messageId = m.messageId,
                conversationId = conversationId,
                senderId = m.senderId,
                plaintext = text,
                timestamp = m.timestamp,
                status = localStatus
            )
        )

        if (!isMine) {
            bandwidth.recordInboundPayload(
                listOf(m.messageId, m.senderId, m.ciphertext, m.iv, m.status),
                true
            )
            if (remoteStatus == MessageStatus.SENT) {
                runCatching { remote.markStatus(conversationId, m.messageId, "DELIVERED") }
            }
        }
        refreshConversationSummary(me, conversationId)
    }

    private suspend fun refreshConversationSummary(me: String, conversationId: String) {
        val convo = db.conversationDao().getById(conversationId) ?: return
        val latest = db.messageDao().getLatest(conversationId)
        val preview = latest?.plaintext?.take(80) ?: ""
        val ts = maxOf(convo.lastMessageTimestamp, latest?.timestamp ?: 0L)
        val unread = db.messageDao().countUnread(conversationId, me)
        db.conversationDao().updateSummary(conversationId, preview, ts, unread)
    }

    // ---------- sending ----------

    suspend fun sendMessage(conversationId: String, text: String) {
        val me = currentUid() ?: return
        val body = text.trim()
        if (body.isEmpty()) return
        val convo = db.conversationDao().getById(conversationId) ?: return

        val msg = MessageEntity(
            messageId = UUID.randomUUID().toString(),
            conversationId = conversationId,
            senderId = me,
            plaintext = body,
            timestamp = System.currentTimeMillis(),
            status = MessageStatus.PENDING
        )
        db.messageDao().insertIfAbsent(msg)
        refreshConversationSummary(me, conversationId)

        var sent = false
        if (connectivity.isOnlineNow()) {
            sent = try {
                sendMutex.withLock { transmit(me, convo, msg) }
                true
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
        }
        if (!sent) scheduleFlush()
    }

    private suspend fun transmit(me: String, convo: ConversationEntity, msg: MessageEntity) {
        if (!ensuredConversations.contains(convo.conversationId)) {
            remote.ensureConversation(convo.conversationId, me, convo.peerUid)
            ensuredConversations.add(convo.conversationId)
        }
        val enc = crypto.encrypt(me, convo.peerPublicKey, convo.conversationId, msg.plaintext)
        remote.sendMessage(
            conversationId = convo.conversationId,
            messageId = msg.messageId,
            senderId = me,
            ciphertext = enc.ciphertext,
            iv = enc.iv,
            timestamp = msg.timestamp
        )
        bandwidth.recordOutboundPayload(
            listOf(msg.messageId, me, enc.ciphertext, enc.iv, "SENT"),
            true
        )
        val current = db.messageDao().getById(msg.messageId)
        if (current != null && rank(current.status) < rank(MessageStatus.SENT)) {
            db.messageDao().updateStatus(msg.messageId, MessageStatus.SENT)
        }
    }

    /** Sends queued offline messages. Never throws; safe to call from any scope. */
    suspend fun flushPendingQueue() {
        val me = currentUid() ?: return
        if (!connectivity.isOnlineNow()) return
        val pending = db.messageDao().getPending()
        for (msg in pending) {
            if (msg.senderId != me) continue
            val convo = db.conversationDao().getById(msg.conversationId) ?: continue
            try {
                sendMutex.withLock {
                    val fresh = db.messageDao().getById(msg.messageId)
                    if (fresh != null && fresh.status == MessageStatus.PENDING && !fresh.deletedLocally) {
                        transmit(me, convo, fresh)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: IOException) {
                break // network trouble: stop and retry later
            } catch (_: Exception) {
                continue
            }
        }
    }

    private fun scheduleFlush() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                    .build()
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork("litewire_flush_queue", ExistingWorkPolicy.KEEP, request)
    }

    // ---------- read receipts & local deletes ----------

    suspend fun markConversationRead(conversationId: String, messages: List<MessageEntity>) {
        val me = currentUid() ?: return
        val unread = messages.filter { it.senderId != me && it.status != MessageStatus.READ }
        if (unread.isEmpty()) return
        unread.forEach { db.messageDao().updateStatus(it.messageId, MessageStatus.READ) }
        db.conversationDao().updateUnread(conversationId, 0)
        if (connectivity.isOnlineNow()) {
            for (m in unread) {
                try {
                    remote.markStatus(conversationId, m.messageId, "READ")
                    bandwidth.recordOutboundPayload(listOf(m.messageId, "READ"), false)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
            }
        }
    }

    suspend fun deleteMessageLocally(messageId: String) {
        val msg = db.messageDao().getById(messageId) ?: return
        db.messageDao().deletePendingById(messageId)
        db.messageDao().softDelete(messageId)
        val me = currentUid() ?: return
        refreshConversationSummary(me, msg.conversationId)
    }

    suspend fun clearConversationLocally(conversationId: String) {
        db.messageDao().deletePendingForConversation(conversationId)
        db.messageDao().softDeleteConversation(conversationId)
        val me = currentUid() ?: return
        refreshConversationSummary(me, conversationId)
    }

    // ---------- safety number ----------

    fun computeSafetyFingerprint(peerPublicKey: String): String {
        if (peerPublicKey.isBlank()) return ""
        val me = currentUid() ?: return ""
        return fingerprintCache.getOrPut("$me|$peerPublicKey") {
            val myPub = crypto.getOrCreatePublicKeyBase64(me)
            crypto.computeSafetyFingerprint(myPub, peerPublicKey)
        }
    }
}
