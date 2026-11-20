package com.litewire.app.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.MessageStatus
import com.litewire.app.data.local.entity.PendingMessageEntity
import com.litewire.app.data.local.entity.UserEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface UserDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertUser(user: UserEntity)

    @Query("SELECT * FROM users WHERE uid = :uid LIMIT 1")
    suspend fun getUser(uid: String): UserEntity?

    @Query("DELETE FROM users")
    suspend fun clearAll()
}

@Dao
interface ConversationDao {
    @Query("SELECT * FROM conversations ORDER BY lastMessageTimestamp DESC")
    fun observeConversations(): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE conversationId = :conversationId LIMIT 1")
    fun observeConversation(conversationId: String): Flow<ConversationEntity?>

    @Query("SELECT * FROM conversations WHERE conversationId = :conversationId LIMIT 1")
    suspend fun getConversation(conversationId: String): ConversationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertConversation(conversation: ConversationEntity)

    @Query("UPDATE conversations SET unreadCount = 0 WHERE conversationId = :conversationId")
    suspend fun clearUnread(conversationId: String)

    @Query("UPDATE conversations SET lastSyncedTimestamp = :ts WHERE conversationId = :conversationId AND lastSyncedTimestamp < :ts")
    suspend fun updateLastSyncedTimestamp(conversationId: String, ts: Long)

    @Query("UPDATE conversations SET peerOnline = :online, peerLastSeen = :lastSeen WHERE peerUid = :peerUid")
    suspend fun updatePeerPresence(peerUid: String, online: Boolean, lastSeen: Long)

    @Query("DELETE FROM conversations")
    suspend fun clearAll()
}

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE conversationId = :conversationId AND isDeletedLocally = 0 ORDER BY timestamp DESC LIMIT :limit")
    fun observeMessagesPaged(conversationId: String, limit: Int): Flow<List<MessageEntity>>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMessageIfAbsent(message: MessageEntity): Long

    @Query("UPDATE messages SET messageId = :serverId, status = :status WHERE clientMsgId = :clientMsgId")
    suspend fun confirmSent(clientMsgId: String, serverId: String, status: MessageStatus)

    @Query("UPDATE messages SET status = :status WHERE messageId = :messageId")
    suspend fun updateStatus(messageId: String, status: MessageStatus)

    @Query("UPDATE messages SET isDeletedLocally = 1 WHERE messageId = :messageId")
    suspend fun deleteMessageLocally(messageId: String)

    @Query("UPDATE messages SET isDeletedLocally = 1 WHERE conversationId = :conversationId")
    suspend fun clearConversationLocally(conversationId: String)

    @Query("SELECT MAX(timestamp) FROM messages WHERE conversationId = :conversationId")
    suspend fun getLatestTimestamp(conversationId: String): Long?

    @Query("DELETE FROM messages")
    suspend fun clearAll()
}

@Dao
interface PendingMessageDao {
    @Query("SELECT * FROM pending_messages ORDER BY createdAt ASC")
    suspend fun getAllPending(): List<PendingMessageEntity>

    @Query("SELECT COUNT(*) FROM pending_messages")
    fun observePendingCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun enqueue(pending: PendingMessageEntity)

    @Query("DELETE FROM pending_messages WHERE clientMsgId = :clientMsgId")
    suspend fun remove(clientMsgId: String)

    @Query("UPDATE pending_messages SET retryCount = retryCount + 1 WHERE clientMsgId = :clientMsgId")
    suspend fun incrementRetry(clientMsgId: String)

    @Query("DELETE FROM pending_messages")
    suspend fun clearAll()
}

@Dao
interface DataMetricDao {
    @Query("SELECT * FROM data_metrics WHERE id = 1")
    fun observeMetrics(): Flow<DataMetricEntity?>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun ensureInitialized(metric: DataMetricEntity = DataMetricEntity())

    @Query("UPDATE data_metrics SET bytesSentExact = bytesSentExact + :bytes, estimatedOverheadBytes = estimatedOverheadBytes + :overhead, messagesSentCount = messagesSentCount + :msgIncrement WHERE id = 1")
    suspend fun recordOutbound(bytes: Long, overhead: Long, msgIncrement: Long)

    @Query("UPDATE data_metrics SET bytesReceivedExact = bytesReceivedExact + :bytes, estimatedOverheadBytes = estimatedOverheadBytes + :overhead, messagesReceivedCount = messagesReceivedCount + :msgIncrement WHERE id = 1")
    suspend fun recordInbound(bytes: Long, overhead: Long, msgIncrement: Long)

    @Query("UPDATE data_metrics SET bytesSentExact = 0, bytesReceivedExact = 0, estimatedOverheadBytes = 0, messagesSentCount = 0, messagesReceivedCount = 0 WHERE id = 1")
    suspend fun reset()
}
