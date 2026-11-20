package com.litewire.app.data.remote

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

data class RemoteUser(
    val uid: String = "",
    val username: String = "",
    val displayName: String = "",
    val publicKey: String = "",
    val online: Boolean = false,
    val lastSeen: Long = 0L
)

data class RemoteMessage(
    val messageId: String = "",
    val clientMsgId: String = "",
    val senderId: String = "",
    val ciphertext: String = "",
    val iv: String = "",
    val timestamp: Long = 0L,
    val status: String = "SENT"
)

data class RemoteConversation(
    val conversationId: String = "",
    val participants: List<String> = emptyList(),
    val updatedAt: Long = 0L
)

class FirebaseDataSource(
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance()
) {

    fun currentUid(): String? = auth.currentUser?.uid

    suspend fun registerUser(
        username: String,
        displayName: String,
        email: String,
        password: String,
        publicKeyProvider: (uid: String) -> String
    ): RemoteUser {
        val cleanUsername = username.trim().lowercase()
        val usernameRef = db.collection("usernames").document(cleanUsername)
        // Firestore rules only allow signed-in reads, so sign up first, then check the name.
        val authResult = auth.createUserWithEmailAndPassword(email.trim(), password).await()
        val uid = authResult.user?.uid ?: throw IllegalStateException("Auth registration failed.")
        val existing = runCatching { usernameRef.get().await() }.getOrNull()
        if (existing != null && existing.exists()) {
            runCatching { authResult.user?.delete()?.await() }
            auth.signOut()
            throw IllegalArgumentException("Username @$cleanUsername is already taken.")
        }
        val publicKey = publicKeyProvider(uid)
        val now = System.currentTimeMillis()

        val user = RemoteUser(
            uid = uid,
            username = cleanUsername,
            displayName = displayName.trim().ifEmpty { cleanUsername },
            publicKey = publicKey,
            online = true,
            lastSeen = now
        )

        val batch = db.batch()
        batch.set(usernameRef, mapOf("uid" to uid))
        batch.set(
            db.collection("users").document(uid),
            mapOf(
                "uid" to user.uid,
                "username" to user.username,
                "displayName" to user.displayName,
                "publicKey" to user.publicKey,
                "online" to true,
                "lastSeen" to now
            )
        )
        batch.commit().await()
        return user
    }

    suspend fun login(email: String, password: String, publicKeyProvider: (uid: String) -> String): RemoteUser {
        val result = auth.signInWithEmailAndPassword(email.trim(), password).await()
        val uid = result.user?.uid ?: throw IllegalStateException("Login failed.")
        val pubKey = publicKeyProvider(uid)
        val now = System.currentTimeMillis()
        db.collection("users").document(uid)
            .set(mapOf("online" to true, "lastSeen" to now, "publicKey" to pubKey), SetOptions.merge())
            .await()

        val snap = db.collection("users").document(uid).get().await()
        return snap.toObject(RemoteUser::class.java) ?: RemoteUser(uid = uid, publicKey = pubKey)
    }

    suspend fun setPresence(online: Boolean) {
        val uid = currentUid() ?: return
        db.collection("users").document(uid)
            .update(mapOf("online" to online, "lastSeen" to System.currentTimeMillis()))
            .await()
    }

    suspend fun saveFcmToken(token: String) {
        val uid = currentUid() ?: return
        db.collection("userTokens").document(uid)
            .set(mapOf("fcmToken" to token, "updatedAt" to System.currentTimeMillis()))
            .await()
    }

    suspend fun logout() {
        runCatching { setPresence(false) }
        auth.signOut()
    }

    suspend fun searchUsersByUsername(queryPrefix: String): List<RemoteUser> {
        val clean = queryPrefix.trim().lowercase().removePrefix("@")
        if (clean.isEmpty()) return emptyList()
        val snap = db.collection("users")
            .orderBy("username")
            .startAt(clean)
            .endAt(clean + "\uf8ff")
            .limit(20)
            .get()
            .await()
        val myUid = currentUid()
        return snap.documents.mapNotNull { it.toObject(RemoteUser::class.java) }
            .filter { it.uid != myUid }
    }

    suspend fun fetchUser(uid: String): RemoteUser? {
        val snap = db.collection("users").document(uid).get().await()
        return snap.toObject(RemoteUser::class.java)
    }

    fun observeConversations(myUid: String): Flow<List<RemoteConversation>> = callbackFlow {
        val reg: ListenerRegistration = db.collection("conversations")
            .whereArrayContains("participants", myUid)
            .addSnapshotListener(MetadataChanges.EXCLUDE) { snap, err ->
                if (err != null) return@addSnapshotListener
                val list = snap?.documents?.map { doc ->
                    RemoteConversation(
                        conversationId = doc.id,
                        participants = (doc.get("participants") as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
                        updatedAt = doc.getLong("updatedAt") ?: 0L
                    )
                } ?: emptyList()
                trySend(list)
            }
        awaitClose { reg.remove() }
    }

    /**
     * Incremental synchronization listener: downloads ONLY messages newer than `sinceTimestamp`.
     */
    fun observeMessagesDelta(conversationId: String, sinceTimestamp: Long): Flow<List<RemoteMessage>> = callbackFlow {
        val reg: ListenerRegistration = db.collection("conversations")
            .document(conversationId)
            .collection("messages")
            .whereGreaterThan("timestamp", sinceTimestamp)
            .orderBy("timestamp", Query.Direction.ASCENDING)
            .limit(50)
            .addSnapshotListener(MetadataChanges.EXCLUDE) { snap, err ->
                if (err != null) return@addSnapshotListener
                val items = snap?.documents?.map { doc ->
                    RemoteMessage(
                        messageId = doc.id,
                        clientMsgId = doc.getString("clientMsgId") ?: doc.id,
                        senderId = doc.getString("senderId") ?: "",
                        ciphertext = doc.getString("ciphertext") ?: "",
                        iv = doc.getString("iv") ?: "",
                        timestamp = doc.getLong("timestamp") ?: 0L,
                        status = doc.getString("status") ?: "SENT"
                    )
                } ?: emptyList()
                trySend(items)
            }
        awaitClose { reg.remove() }
    }

    suspend fun ensureConversation(myUid: String, peerUid: String): String {
        val sorted = listOf(myUid, peerUid).sorted()
        val convoId = "${sorted[0]}_${sorted[1]}"
        // Merge-set creates the chat if missing and is a harmless no-op if it exists.
        // (Reading a missing document first is refused by the security rules.)
        db.collection("conversations").document(convoId)
            .set(mapOf("participants" to sorted), SetOptions.merge())
            .await()
        return convoId
    }

    suspend fun sendEncryptedMessage(
        conversationId: String,
        clientMsgId: String,
        senderId: String,
        ciphertext: String,
        iv: String,
        timestamp: Long
    ): String {
        val convoRef = db.collection("conversations").document(conversationId)
        // Use clientMsgId as document ID so retries are strictly idempotent (zero duplicates)
        val msgRef = convoRef.collection("messages").document(clientMsgId)
        val batch = db.batch()
        batch.set(
            msgRef,
            mapOf(
                "clientMsgId" to clientMsgId,
                "senderId" to senderId,
                "ciphertext" to ciphertext,
                "iv" to iv,
                "timestamp" to timestamp,
                "status" to "SENT"
            )
        )
        batch.set(convoRef, mapOf("updatedAt" to timestamp), SetOptions.merge())
        batch.commit().await()
        return msgRef.id
    }

    suspend fun updateMessageStatus(conversationId: String, messageId: String, status: String) {
        val field = if (status == "READ") "readAt" else "deliveredAt"
        db.collection("conversations")
            .document(conversationId)
            .collection("messages")
            .document(messageId)
            .update(mapOf("status" to status, field to System.currentTimeMillis()))
            .await()
    }
}
