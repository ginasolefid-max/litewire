package com.litewire.app.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.MessageStatus
import com.litewire.app.data.local.entity.UserEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface UserDao {
    @Query("SELECT * FROM users WHERE uid = :uid LIMIT 1")
    suspend fun get(uid: String): UserEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(user: UserEntity)

    @Query("DELETE FROM users")
    suspend fun clear()
}

@Dao
interface ConversationDao {
    @Query("SELECT * FROM conversations ORDER BY lastMessageTimestamp DESC")
    fun observeAll(): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE conversationId = :id LIMIT 1")
    fun observeById(id: String): Flow<ConversationEntity?>

    @Query("SELECT * FROM conversations WHERE conversationId = :id LIMIT 1")
    suspend fun getById(id: String): ConversationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(conversation: ConversationEntity)

    @Query(
        "UPDATE conversations SET peerUsername = :username, peerDisplayName = :displayName, " +
            "peerPublicKey = :publicKey, peerOnline = :online WHERE conversationId = :id"
    )
    suspend fun updatePeer(
        id: String,
        username: String,
        displayName: String,
        publicKey: String,
        online: Boolean
    )

    @Query(
        "UPDATE conversations SET lastMessagePreview = :preview, lastMessageTimestamp = :timestamp, " +
            "unreadCount = :unread WHERE conversationId = :id"
    )
    suspend fun updateSummary(id: String, preview: String, timestamp: Long, unread: Int)

    @Query("UPDATE conversations SET unreadCount = :count WHERE conversationId = :id")
    suspend fun updateUnread(id: String, count: Int)

    @Query("DELETE FROM conversations")
    suspend fun clear()
}

@Dao
interface MessageDao {
    @Query(
        "SELECT * FROM messages WHERE conversationId = :conversationId AND deletedLocally = 0 " +
            "ORDER BY timestamp DESC LIMIT :limit"
    )
    fun observePaged(conversationId: String, limit: Int): Flow<List<MessageEntity>>

    @Query("SELECT COUNT(*) FROM messages WHERE status = 'PENDING' AND deletedLocally = 0")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT * FROM messages WHERE status = 'PENDING' AND deletedLocally = 0 ORDER BY timestamp ASC")
    suspend fun getPending(): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE messageId = :id LIMIT 1")
    suspend fun getById(id: String): MessageEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfAbsent(message: MessageEntity): Long

    @Query("UPDATE messages SET status = :status WHERE messageId = :id")
    suspend fun updateStatus(id: String, status: MessageStatus)

    @Query(
        "SELECT COUNT(*) FROM messages WHERE conversationId = :conversationId " +
            "AND senderId != :myUid AND status != 'READ' AND deletedLocally = 0"
    )
    suspend fun countUnread(conversationId: String, myUid: String): Int

    @Query(
        "SELECT * FROM messages WHERE conversationId = :conversationId AND deletedLocally = 0 " +
            "ORDER BY timestamp DESC LIMIT 1"
    )
    suspend fun getLatest(conversationId: String): MessageEntity?

    @Query("DELETE FROM messages WHERE messageId = :id AND status = 'PENDING'")
    suspend fun deletePendingById(id: String)

    @Query("UPDATE messages SET deletedLocally = 1 WHERE messageId = :id")
    suspend fun softDelete(id: String)

    @Query("DELETE FROM messages WHERE conversationId = :conversationId AND status = 'PENDING'")
    suspend fun deletePendingForConversation(conversationId: String)

    @Query("UPDATE messages SET deletedLocally = 1 WHERE conversationId = :conversationId")
    suspend fun softDeleteConversation(conversationId: String)

    @Query("DELETE FROM messages")
    suspend fun clear()
}

@Dao
interface DataMetricDao {
    @Query("SELECT * FROM data_metrics WHERE id = 1")
    fun observeMetrics(): Flow<DataMetricEntity?>

    @Query(
        "INSERT OR IGNORE INTO data_metrics " +
            "(id, bytesSentExact, bytesReceivedExact, estimatedOverheadBytes, messagesSentCount, messagesReceivedCount) " +
            "VALUES (1, 0, 0, 0, 0, 0)"
    )
    suspend fun ensureInitialized()

    @Query(
        "UPDATE data_metrics SET bytesSentExact = bytesSentExact + :bytes, " +
            "estimatedOverheadBytes = estimatedOverheadBytes + :overhead, " +
            "messagesSentCount = messagesSentCount + :msgIncrement WHERE id = 1"
    )
    suspend fun recordOutbound(bytes: Long, overhead: Long, msgIncrement: Long)

    @Query(
        "UPDATE data_metrics SET bytesReceivedExact = bytesReceivedExact + :bytes, " +
            "estimatedOverheadBytes = estimatedOverheadBytes + :overhead, " +
            "messagesReceivedCount = messagesReceivedCount + :msgIncrement WHERE id = 1"
    )
    suspend fun recordInbound(bytes: Long, overhead: Long, msgIncrement: Long)

    @Query(
        "UPDATE data_metrics SET bytesSentExact = 0, bytesReceivedExact = 0, " +
            "estimatedOverheadBytes = 0, messagesSentCount = 0, messagesReceivedCount = 0 WHERE id = 1"
    )
    suspend fun reset()
}
