package com.litewire.app.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class MessageStatus { PENDING, SENT, DELIVERED, READ }

@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey val uid: String,
    val username: String,
    val displayName: String,
    val publicKey: String
)

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val conversationId: String,
    val peerUid: String,
    val peerUsername: String,
    val peerDisplayName: String,
    val peerPublicKey: String,
    val peerOnline: Boolean = false,
    val lastMessagePreview: String = "",
    val lastMessageTimestamp: Long = 0L,
    val unreadCount: Int = 0
)

@Entity(
    tableName = "messages",
    indices = [Index("conversationId"), Index("status")]
)
data class MessageEntity(
    @PrimaryKey val messageId: String,
    val conversationId: String,
    val senderId: String,
    val plaintext: String,
    val timestamp: Long,
    val status: MessageStatus,
    val deletedLocally: Boolean = false
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
