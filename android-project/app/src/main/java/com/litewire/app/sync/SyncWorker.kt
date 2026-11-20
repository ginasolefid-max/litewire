package com.litewire.app.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.litewire.app.LiteWireApplication

/**
 * WorkManager worker that automatically transmits queued offline messages
 * once Android restores Wi-Fi or cellular internet connectivity, using
 * exponential backoff on transient failures.
 */
class SyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as LiteWireApplication
        return try {
            app.repository.flushPendingQueue()
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
