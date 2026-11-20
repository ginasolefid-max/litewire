package com.litewire.app.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import com.litewire.app.data.local.dao.ConversationDao
import com.litewire.app.data.local.dao.DataMetricDao
import com.litewire.app.data.local.dao.MessageDao
import com.litewire.app.data.local.dao.PendingMessageDao
import com.litewire.app.data.local.dao.UserDao
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.MessageStatus
import com.litewire.app.data.local.entity.PendingMessageEntity
import com.litewire.app.data.local.entity.UserEntity

class Converters {
    @TypeConverter
    fun fromStatus(status: MessageStatus): String = status.name

    @TypeConverter
    fun toStatus(value: String): MessageStatus = MessageStatus.valueOf(value)
}

@Database(
    entities = [
        UserEntity::class,
        ConversationEntity::class,
        MessageEntity::class,
        PendingMessageEntity::class,
        DataMetricEntity::class
    ],
    version = 1,
    exportSchema = false
)
@TypeConverters(Converters::class)
abstract class LiteWireDatabase : RoomDatabase() {
    abstract fun userDao(): UserDao
    abstract fun conversationDao(): ConversationDao
    abstract fun messageDao(): MessageDao
    abstract fun pendingMessageDao(): PendingMessageDao
    abstract fun dataMetricDao(): DataMetricDao

    companion object {
        @Volatile
        private var INSTANCE: LiteWireDatabase? = null

        fun getInstance(context: Context): LiteWireDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    LiteWireDatabase::class.java,
                    "litewire.db"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
