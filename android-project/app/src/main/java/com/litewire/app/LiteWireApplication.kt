package com.litewire.app

import android.app.Application
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.PersistentCacheSettings
import com.litewire.app.crypto.CryptoManager
import com.litewire.app.data.local.LiteWireDatabase
import com.litewire.app.data.remote.FirebaseDataSource
import com.litewire.app.data.repository.MessagingRepository
import com.litewire.app.util.BandwidthMonitor
import com.litewire.app.util.ConnectivityObserver

class LiteWireApplication : Application() {

    lateinit var database: LiteWireDatabase
        private set
    lateinit var cryptoManager: CryptoManager
        private set
    lateinit var remoteDataSource: FirebaseDataSource
        private set
    lateinit var repository: MessagingRepository
        private set

    override fun onCreate() {
        super.onCreate()

        // Configure bounded local cache in Firestore to minimize redundant network reads
        val settings = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(
                PersistentCacheSettings.newBuilder()
                    .setSizeBytes(10L * 1024L * 1024L) // 10 MB cap
                    .build()
            )
            .build()
        FirebaseFirestore.getInstance().firestoreSettings = settings

        database = LiteWireDatabase.getInstance(this)
        cryptoManager = CryptoManager(this)
        remoteDataSource = FirebaseDataSource()

        val bandwidth = BandwidthMonitor(database.dataMetricDao())
        val connectivity = ConnectivityObserver(this)

        repository = MessagingRepository(
            context = this,
            db = database,
            remote = remoteDataSource,
            crypto = cryptoManager,
            bandwidth = bandwidth,
            connectivity = connectivity
        )
    }
}
