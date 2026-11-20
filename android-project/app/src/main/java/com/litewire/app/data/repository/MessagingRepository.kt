package com.litewire.app.data.repository

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.litewire.app.crypto.CryptoManager
import com.litewire.app.data.local.LiteWireDatabase
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.MessageStatus
import com.litewire.app.data.local.entity.PendingMessageEntity
import com.litewire.app.data.local.entity.UserEntity
import com.litewire.app.data.remote.FirebaseDataSource
import com.litewire.app.data.remote.RemoteUser
import com.litewire.app.sync.SyncWorker
import com.litewire.app.util.BandwidthMonitor
import com.litewire.app.util.ConnectivityObserver
import com.litewire.app.util.NetworkType as AppNetworkType
import kotlinx.coroutines.flow.Flow
import java.util.UUID
import java.util.concurrent.TimeUnit

class MessagingRepository(
    private val context: Context,
    private val db: LiteWireDatabase,
    private val remote: FirebaseDataSource,
    private val crypto: CryptoManager,
    val bandwidth: BandwidthMonitor,
    val connectivity: ConnectivityObserver
) {
    private val userDao = db.userDao()
    private val convoDao = db.conversationDao()
    private val msgDao = db.messageDao()
    private val pendingDao = db.pendingMessageDao()

    fun currentUid(): String? = remote.currentUid()

    fun observeConversations(): Flow<List<ConversationEntity>> = convoDao.observeConversations()

    fun observeConversation(conversationId: String): Flow<ConversationEntity?> =
        convoDao.observeConversation(conversationId)

    fun observeMessagesPaged(conversationId: String, pageSize: Int): Flow<List<MessageEntity>> =
        msgDao.observeMessagesPaged(conversationId, pageSize)

    fun observePendingCount(): Flow<Int> = pendingDao.observePendingCount()

    fun observeDataMetrics(): Flow<DataMetricEntity> = bandwidth.observeMetrics()

    fun observeNetworkType(): Flow<AppNetworkType> = connectivity.observeNetworkType()

    suspend fun register(
        username: String,
        displayName: String,
        email: String,
        password: String
    ): RemoteUser {
        bandwidth.ensureInitialized()
        val user = remote.registerUser(username, displayName, email, password) { uid ->
            crypto.getOrCreatePublicKeyBase64(uid)
        }
        userDao.upsertUser(
            UserEntity(user.uid, user.username, user.displayName, user.publicKey, true, user.lastSeen)
        )
        return user
    }

    suspend fun login(email: String, password: String): RemoteUser {
        bandwidth.ensureInitialized()
        val user = remote.login(email, password) { uid ->
            crypto.getOrCreatePublicKeyBase64(uid)
        }
        userDao.upsertUser(
            UserEntity(user.uid, user.username, user.displayName, user.publicKey, true, user.lastSeen)
        )
        scheduleOfflineFlush()
        return user
    }

    suspend fun logout() {
        remote.logout()
        userDao.clearAll()
        convoDao.clearAll()
        msgDao.clearAll()
        pendingDao.clearAll()
        crypto.clearKeys()
    }

    suspend fun getCurrentUserProfile(): UserEntity? {
        val uid = currentUid() ?: return null
        val local = userDao.getUser(uid)
        if (local != null) return local
        val r = remote.fetchUser(uid) ?: return null
        val entity = UserEntity(r.uid, r.username, r.displayName, r.publicKey, r.online, r.lastSeen)
        userDao.upsertUser(entity)
        return entity
    }

    suspend fun searchUsers(prefix: String): List<RemoteUser> = remote.searchUsersByUsername(prefix)

    suspend fun startOrGetConversation(peer: RemoteUser): String {
        val myUid = currentUid() ?: throw IllegalStateException("Not authenticated")
        val sorted = listOf(myUid, peer.uid).sorted()
        val convoId = "${sorted[0]}_${sorted[1]}"
        val existing = convoDao.getConversation(convoId)
        if (existing == null) {
            convoDao.upsertConversation(
                ConversationEntity(
                    conversationId = convoId,
                    peerUid = peer.uid,
                    peerUsername = peer.username,
                    peerDisplayName = peer.displayName,
                    peerPublicKey = peer.publicKey,
                    peerOnline = peer.online,
                    peerLastSeen = peer.lastSeen,
                    lastMessagePreview = "Encrypted chat started",
                    lastMessageTimestamp = System.currentTimeMillis(),
                    lastSyncedTimestamp = 0L,
                    unreadCount = 0
                )
            )
        }
        if (connectivity.isOnlineNow()) {
            runCatching { remote.ensureConversation(myUid, peer.uid) }
        }
        return convoId
    }

    /**
     * Encrypts message client-side, inserts locally with PENDING status,
     * queues in Room `pending_messages`, and attempts immediate send or schedules WorkManager.
     */
    suspend fun sendMessage(conversationId: String, plaintext: String) {
        val myUid = currentUid() ?: return
        val convo = convoDao.getConversation(conversationId) ?: return
        val trimmed = plaintext.trim()
        if (trimmed.isEmpty()) return

        val clientMsgId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val encrypted = crypto.encrypt(myUid, convo.peerPublicKey, conversationId, trimmed)

        // 1. Insert optimistically into local message history as PENDING
        msgDao.insertMessageIfAbsent(
            MessageEntity(
                messageId = clientMsgId,
                clientMsgId = clientMsgId,
                conversationId = conversationId,
                senderId = myUid,
                plaintext = trimmed,
                timestamp = now,
                status = MessageStatus.PENDING
            )
        )

        convoDao.upsertConversation(
            convo.copy(
                lastMessagePreview = trimmed,
                lastMessageTimestamp = now
            )
        )

        // 2. Persist into durable offline queue
        pendingDao.enqueue(
            PendingMessageEntity(
                clientMsgId = clientMsgId,
                conversationId = conversationId,
                recipientUid = convo.peerUid,
                recipientPublicKey = convo.peerPublicKey,
                plaintext = trimmed,
                ciphertext = encrypted.ciphertext,
                iv = encrypted.iv,
                createdAt = now
            )
        )

        // 3. Flush immediately if online, otherwise schedule exponential-backoff WorkManager
        if (connectivity.isOnlineNow()) {
            flushPendingQueue()
        } else {
            scheduleOfflineFlush()
        }
    }

    suspend fun flushPendingQueue() {
        val myUid = currentUid() ?: return
        if (!connectivity.isOnlineNow()) {
            scheduleOfflineFlush()
            return
        }
        val items = pendingDao.getAllPending()
        for (item in items) {
            try {
                remote.ensureConversation(myUid, item.recipientUid)
                val serverId = remote.sendEncryptedMessage(
                    conversationId = item.conversationId,
                    clientMsgId = item.clientMsgId,
                    senderId = myUid,
                    ciphertext = item.ciphertext,
                    iv = item.iv,
                    timestamp = item.createdAt
                )
                bandwidth.recordOutboundPayload(
                    listOf(item.clientMsgId, myUid, item.ciphertext, item.iv),
                    isMessage = true
                )
                msgDao.confirmSent(item.clientMsgId, serverId, MessageStatus.SENT)
                pendingDao.remove(item.clientMsgId)
            } catch (_: Exception) {
                pendingDao.incrementRetry(item.clientMsgId)
                scheduleOfflineFlush()
            }
        }
    }

    suspend fun syncConversationMetadata() = kotlinx.coroutines.coroutineScope {
        val myUid = currentUid() ?: return@coroutineScope
        val listening = mutableSetOf<String>()
        remote.observeConversations(myUid).collect { remoteConvos ->
            for (rc in remoteConvos) {
                val peerUid = rc.participants.firstOrNull { it != myUid } ?: continue
                val peer = runCatching { remote.fetchUser(peerUid) }.getOrNull() ?: continue
                val existing = convoDao.getConversation(rc.conversationId)
                convoDao.upsertConversation(
                    ConversationEntity(
                        conversationId = rc.conversationId,
                        peerUid = peer.uid,
                        peerUsername = peer.username,
                        peerDisplayName = peer.displayName,
                        peerPublicKey = peer.publicKey,
                        peerOnline = peer.online,
                        peerLastSeen = peer.lastSeen,
                        lastMessagePreview = existing?.lastMessagePreview ?: "Encrypted message",
                        lastMessageTimestamp = maxOf(existing?.lastMessageTimestamp ?: 0L, rc.updatedAt),
                        lastSyncedTimestamp = existing?.lastSyncedTimestamp ?: 0L,
                        unreadCount = existing?.unreadCount ?: 0
                    )
                )
                // Start receiving this chat's messages in the background right away.
                if (listening.add(rc.conversationId)) {
                    launch { runCatching { syncIncomingMessages(rc.conversationId) } }
                }
            }
        }
    }

    suspend fun syncIncomingMessages(conversationId: String) {
        val myUid = currentUid() ?: return
        val convo = convoDao.getConversation(conversationId) ?: return
        val since = msgDao.getLatestTimestamp(conversationId) ?: convo.lastSyncedTimestamp

        remote.observeMessagesDelta(conversationId, since).collect { delta ->
            for (rm in delta) {
                val decrypted = runCatching {
                    crypto.decrypt(myUid, convo.peerPublicKey, conversationId, rm.ciphertext, rm.iv)
                }.getOrElse { "[Unable to decrypt message]" }

                val status = runCatching { MessageStatus.valueOf(rm.status) }
                    .getOrDefault(MessageStatus.SENT)

                val inserted = msgDao.insertMessageIfAbsent(
                    MessageEntity(
                        messageId = rm.messageId,
                        clientMsgId = rm.clientMsgId,
                        conversationId = conversationId,
                        senderId = rm.senderId,
                        plaintext = decrypted,
                        timestamp = rm.timestamp,
                        status = status
                    )
                )

                if (inserted > 0L) {
                    bandwidth.recordInboundPayload(
                        listOf(rm.messageId, rm.senderId, rm.ciphertext, rm.iv),
                        isMessage = rm.senderId != myUid
                    )
                    if (rm.senderId != myUid && status == MessageStatus.SENT) {
                        runCatching { remote.updateMessageStatus(conversationId, rm.messageId, "DELIVERED") }
                    }
                    val latestConvo = convoDao.getConversation(conversationId)
                    if (latestConvo != null) {
                        convoDao.upsertConversation(
                            latestConvo.copy(
                                lastMessagePreview = decrypted,
                                lastMessageTimestamp = maxOf(latestConvo.lastMessageTimestamp, rm.timestamp),
                                lastSyncedTimestamp = maxOf(latestConvo.lastSyncedTimestamp, rm.timestamp),
                                unreadCount = if (rm.senderId != myUid) latestConvo.unreadCount + 1 else latestConvo.unreadCount
                            )
                        )
                    }
                } else {
                    msgDao.updateStatus(rm.messageId, status)
                }
            }
        }
    }

    suspend fun markConversationRead(conversationId: String, visibleMessages: List<MessageEntity>) {
        val myUid = currentUid() ?: return
        convoDao.clearUnread(conversationId)
        for (m in visibleMessages) {
            if (m.senderId != myUid && m.status != MessageStatus.READ) {
                msgDao.updateStatus(m.messageId, MessageStatus.READ)
                if (connectivity.isOnlineNow()) {
                    runCatching { remote.updateMessageStatus(conversationId, m.messageId, "READ") }
                }
            }
        }
    }

    suspend fun deleteMessageLocally(messageId: String) = msgDao.deleteMessageLocally(messageId)

    suspend fun clearConversationLocally(conversationId: String) = msgDao.clearConversationLocally(conversationId)

    fun computeSafetyFingerprint(peerPublicKey: String): String {
        val uid = currentUid() ?: return ""
        val myPub = crypto.getOrCreatePublicKeyBase64(uid)
        return crypto.computeSafetyFingerprint(myPub, peerPublicKey)
    }

    fun scheduleOfflineFlush() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            "litewire_offline_flush",
            ExistingWorkPolicy.KEEP,
            request
        )
    }
}
