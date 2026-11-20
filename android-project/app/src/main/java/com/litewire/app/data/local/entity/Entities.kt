package com.litewire.app.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class MessageStatus {
    PENDING,
    SENT,
    DELIVERED,
    READ
}

@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey val uid: String,
    val username: String,
    val displayName: String,
    val publicKey: String,
    val online: Boolean,
    val lastSeen: Long
)

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val conversationId: String,
    val peerUid: String,
    val peerUsername: String,
    val peerDisplayName: String,
    val peerPublicKey: String,
    val peerOnline: Boolean,
    val peerLastSeen: Long,
    val lastMessagePreview: String,
    val lastMessageTimestamp: Long,
    val lastSyncedTimestamp: Long,
    val unreadCount: Int
)

@Entity(
    tableName = "messages",
    indices = [
        Index(value = ["conversationId", "timestamp"]),
        Index(value = ["clientMsgId"], unique = true)
    ]
)
data class MessageEntity(
    @PrimaryKey val messageId: String,
    val clientMsgId: String,
    val conversationId: String,
    val senderId: String,
    val plaintext: String,
    val timestamp: Long,
    val status: MessageStatus,
    val isDeletedLocally: Boolean = false
)

@Entity(
    tableName = "pending_messages",
    indices = [Index(value = ["clientMsgId"], unique = true)]
)
data class PendingMessageEntity(
    @PrimaryKey val clientMsgId: String,
    val conversationId: String,
    val recipientUid: String,
    val recipientPublicKey: String,
    val plaintext: String,
    val ciphertext: String,
    val iv: String,
    val createdAt: Long,
    val retryCount: Int = 0
)

@Entity(tableName = "data_metrics")
data class DataMetricEntity(
    @PrimaryKey val id: Int = 1,
    val bytesSentExact: Long = 0L,
    val bytesReceivedExact: Long = 0L,
    val estimatedOverheadBytes: Long = 0L,
    val messagesSentCount: Long = 0L,
    val messagesReceivedCount: Long = 0L
)
