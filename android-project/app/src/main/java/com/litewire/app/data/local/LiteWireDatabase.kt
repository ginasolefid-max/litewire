package com.litewire.app.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import com.litewire.app.data.local.dao.ConversationDao
import com.litewire.app.data.local.dao.DataMetricDao
import com.litewire.app.data.local.dao.MessageDao
import com.litewire.app.data.local.dao.UserDao
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.UserEntity

@Database(
    entities = [
        UserEntity::class,
        ConversationEntity::class,
        MessageEntity::class,
        DataMetricEntity::class
    ],
    version = 1,
    exportSchema = false
)
abstract class LiteWireDatabase : RoomDatabase() {

    abstract fun userDao(): UserDao
    abstract fun conversationDao(): ConversationDao
    abstract fun messageDao(): MessageDao
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
                    .addCallback(object : RoomDatabase.Callback() {
                        override fun onOpen(db: SupportSQLiteDatabase) {
                            super.onOpen(db)
                            db.execSQL(
                                "INSERT OR IGNORE INTO data_metrics " +
                                    "(id, bytesSentExact, bytesReceivedExact, estimatedOverheadBytes, " +
                                    "messagesSentCount, messagesReceivedCount) VALUES (1, 0, 0, 0, 0, 0)"
                            )
                        }
                    })
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
