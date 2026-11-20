package com.litewire.app.util

import com.litewire.app.data.local.dao.DataMetricDao
import com.litewire.app.data.local.entity.DataMetricEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.nio.charset.StandardCharsets

/**
 * Measures EXACT UTF-8 serialized application payload bytes sent/received
 * and estimates IP/TCP/TLS transport overhead (~64 bytes per packet exchange).
 */
class BandwidthMonitor(private val metricDao: DataMetricDao) {

    companion object {
        private const val ESTIMATED_TLS_TCP_OVERHEAD_BYTES = 64L
    }

    fun observeMetrics(): Flow<DataMetricEntity> =
        metricDao.observeMetrics().map { it ?: DataMetricEntity() }

    suspend fun ensureInitialized() {
        metricDao.ensureInitialized()
    }

    suspend fun recordOutboundPayload(serializedFields: List<String>, isMessage: Boolean) {
        val exactBytes = serializedFields.sumOf {
            it.toByteArray(StandardCharsets.UTF_8).size.toLong()
        } + 32L // compact JSON field keys overhead
        metricDao.recordOutbound(
            bytes = exactBytes,
            overhead = ESTIMATED_TLS_TCP_OVERHEAD_BYTES,
            msgIncrement = if (isMessage) 1L else 0L
        )
    }

    suspend fun recordInboundPayload(serializedFields: List<String>, isMessage: Boolean) {
        val exactBytes = serializedFields.sumOf {
            it.toByteArray(StandardCharsets.UTF_8).size.toLong()
        } + 32L
        metricDao.recordInbound(
            bytes = exactBytes,
            overhead = ESTIMATED_TLS_TCP_OVERHEAD_BYTES,
            msgIncrement = if (isMessage) 1L else 0L
        )
    }

    suspend fun resetMetrics() {
        metricDao.reset()
    }
}
