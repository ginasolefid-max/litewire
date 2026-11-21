package com.litewire.app.data.remote

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentChange
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Query
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

data class RemoteUser(
    val uid: String,
    val username: String,
    val displayName: String,
    val publicKey: String,
    val online: Boolean
)

data class RemoteChatMessage(
    val messageId: String,
    val senderId: String,
    val ciphertext: String,
    val iv: String,
    val timestamp: Long,
    val status: String
)

data class RemoteConversation(
    val conversationId: String,
    val participants: List<String>,
    val updatedAt: Long
)

/**
 * Thin Firestore / Firebase Auth wrapper. Only ciphertext ever leaves the device.
 * Collections: users, usernames, userTokens, conversations/{id}/messages.
 */
class FirebaseDataSource(
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance()
) {

    // ---------- helpers ----------

    private suspend fun netWrite(timeoutMs: Long = 20_000, block: suspend () -> Unit) {
        withTimeoutOrNull(timeoutMs) {
            block()
            true
        } ?: throw IOException("Network timeout")
    }

    private suspend fun <T : Any> netRead(timeoutMs: Long = 20_000, block: suspend () -> T): T {
        return withTimeoutOrNull(timeoutMs) { block() } ?: throw IOException("Network timeout")
    }

    private fun DocumentSnapshot.toRemoteUser(): RemoteUser? {
        if (!exists()) return null
        val username = getString("username") ?: return null
        return RemoteUser(
            uid = getString("uid") ?: id,
            username = username,
            displayName = getString("displayName") ?: username,
            publicKey = getString("publicKey") ?: "",
            online = getBoolean("online") ?: false
        )
    }

    private fun DocumentSnapshot.toRemoteMessage(): RemoteChatMessage? {
        if (!exists()) return null
        val sender = getString("senderId") ?: return null
        val ct = getString("ciphertext") ?: return null
        val iv = getString("iv") ?: return null
        return RemoteChatMessage(
            messageId = id,
            senderId = sender,
            ciphertext = ct,
            iv = iv,
            timestamp = getLong("timestamp") ?: 0L,
            status = getString("status") ?: "SENT"
        )
    }

    private fun DocumentSnapshot.toRemoteConversation(): RemoteConversation? {
        if (!exists()) return null
        val participants = (get("participants") as? List<*>)?.filterIsInstance<String>() ?: return null
        return RemoteConversation(
            conversationId = id,
            participants = participants,
            updatedAt = getLong("updatedAt") ?: 0L
        )
    }

    // ---------- auth ----------

    fun currentUid(): String? = auth.currentUser?.uid

    suspend fun createAuthUser(email: String, password: String): String {
        val result = auth.createUserWithEmailAndPassword(email, password).await()
        return result.user?.uid ?: throw IllegalStateException("Account creation failed.")
    }

    suspend fun signIn(email: String, password: String): String {
        val result = auth.signInWithEmailAndPassword(email, password).await()
        return result.user?.uid ?: throw IllegalStateException("Login failed.")
    }

    suspend fun deleteCurrentAuthUser() {
        auth.currentUser?.delete()?.await()
    }

    fun signOut() {
        auth.signOut()
    }

    // ---------- users ----------

    suspend fun createProfile(uid: String, username: String, displayName: String, publicKey: String) {
        val usernameRef = firestore.collection("usernames").document(username)
        val userRef = firestore.collection("users").document(uid)
        val taken = netRead { usernameRef.get().await() }.exists()
        if (taken) throw IllegalStateException("Username @$username is already taken.")

        netWrite {
            val batch = firestore.batch()
            batch.set(
                userRef,
                mapOf(
                    "uid" to uid,
                    "username" to username,
                    "displayName" to displayName,
                    "publicKey" to publicKey,
                    "online" to false,
                    "lastSeen" to System.currentTimeMillis()
                )
            )
            batch.set(usernameRef, mapOf("uid" to uid))
            batch.commit().await()
        }
    }

    suspend fun getUser(uid: String): RemoteUser? {
        val snap = netRead { firestore.collection("users").document(uid).get().await() }
        return snap.toRemoteUser()
    }

    suspend fun updatePublicKey(uid: String, publicKey: String) {
        netWrite {
            firestore.collection("users").document(uid).update("publicKey", publicKey).await()
        }
    }

    suspend fun setPresence(uid: String, online: Boolean) {
        netWrite(timeoutMs = 5_000) {
            firestore.collection("users").document(uid)
                .update(mapOf("online" to online, "lastSeen" to System.currentTimeMillis()))
                .await()
        }
    }

    suspend fun searchUsers(prefix: String, limit: Long = 20): List<RemoteUser> {
        val snap = netRead {
            firestore.collection("users")
                .orderBy("username")
                .startAt(prefix)
                .endAt(prefix + "\uf8ff")
                .limit(limit)
                .get()
                .await()
        }
        return snap.documents.mapNotNull { it.toRemoteUser() }
    }

    // ---------- push token ----------

    suspend fun saveFcmToken(token: String) {
        val uid = currentUid() ?: return
        netWrite {
            firestore.collection("userTokens").document(uid).set(mapOf("fcmToken" to token)).await()
        }
    }

    suspend fun registerCurrentFcmToken() {
        val token = FirebaseMessaging.getInstance().token.await()
        saveFcmToken(token)
    }

    // ---------- conversations ----------

    suspend fun ensureConversation(conversationId: String, myUid: String, peerUid: String) {
        val ref = firestore.collection("conversations").document(conversationId)
        val exists = netRead { ref.get().await() }.exists()
        if (!exists) {
            netWrite {
                ref.set(
                    mapOf(
                        "participants" to listOf(myUid, peerUid).sorted(),
                        "updatedAt" to System.currentTimeMillis()
                    )
                ).await()
            }
        }
    }

    /** Live list of my conversations (sorted client-side so no composite index is needed). */
    fun observeConversations(myUid: String): Flow<List<RemoteConversation>> = callbackFlow {
        val registration = firestore.collection("conversations")
            .whereArrayContains("participants", myUid)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                if (snap == null) return@addSnapshotListener
                trySend(snap.documents.mapNotNull { it.toRemoteConversation() })
            }
        awaitClose { registration.remove() }
    }

    // ---------- messages ----------

    suspend fun sendMessage(
        conversationId: String,
        messageId: String,
        senderId: String,
        ciphertext: String,
        iv: String,
        timestamp: Long
    ) {
        val convoRef = firestore.collection("conversations").document(conversationId)
        val msgRef = convoRef.collection("messages").document(messageId)
        try {
            netWrite {
                val batch = firestore.batch()
                batch.set(
                    msgRef,
                    mapOf(
                        "senderId" to senderId,
                        "ciphertext" to ciphertext,
                        "iv" to iv,
                        "clientMsgId" to messageId,
                        "timestamp" to timestamp,
                        "status" to "SENT"
                    )
                )
                batch.update(convoRef, "updatedAt", timestamp)
                batch.commit().await()
            }
        } catch (e: FirebaseFirestoreException) {
            // A retry of an already-delivered message is rejected by the rules (it looks like an update).
            if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED && messageExists(msgRef)) return
            throw e
        }
    }

    private suspend fun messageExists(ref: com.google.firebase.firestore.DocumentReference): Boolean {
        return try {
            netRead { ref.get().await() }.exists()
        } catch (_: Exception) {
            false
        }
    }

    /** Live changes for the newest messages of one conversation (cache-backed, so cheap on data). */
    fun observeMessages(conversationId: String, limit: Long = 100): Flow<List<RemoteChatMessage>> =
        callbackFlow {
            val registration = firestore.collection("conversations").document(conversationId)
                .collection("messages")
                .orderBy("timestamp", Query.Direction.DESCENDING)
                .limit(limit)
                .addSnapshotListener { snap, err ->
                    if (err != null) {
                        close(err)
                        return@addSnapshotListener
                    }
                    if (snap == null) return@addSnapshotListener
                    val changes = snap.documentChanges
                        .filter {
                            it.type != DocumentChange.Type.REMOVED &&
                                !it.document.metadata.hasPendingWrites()
                        }
                        .mapNotNull { it.document.toRemoteMessage() }
                        .sortedBy { it.timestamp }
                    if (changes.isNotEmpty()) trySend(changes)
                }
            awaitClose { registration.remove() }
        }

    suspend fun fetchRecentMessages(conversationId: String, limit: Long = 30): List<RemoteChatMessage> {
        val snap = netRead {
            firestore.collection("conversations").document(conversationId)
                .collection("messages")
                .orderBy("timestamp", Query.Direction.DESCENDING)
                .limit(limit)
                .get()
                .await()
        }
        return snap.documents.mapNotNull { it.toRemoteMessage() }
    }

    /** status must be "DELIVERED" or "READ" (enforced by Firestore rules). */
    suspend fun markStatus(conversationId: String, messageId: String, status: String) {
        val field = if (status == "READ") "readAt" else "deliveredAt"
        netWrite {
            firestore.collection("conversations").document(conversationId)
                .collection("messages").document(messageId)
                .update(mapOf("status" to status, field to System.currentTimeMillis()))
                .await()
        }
    }
}
