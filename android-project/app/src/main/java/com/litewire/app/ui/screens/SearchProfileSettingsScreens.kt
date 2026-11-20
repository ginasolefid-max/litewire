package com.litewire.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.UserEntity
import com.litewire.app.data.remote.RemoteUser
import com.litewire.app.util.NetworkType

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UserSearchScreen(
    results: List<RemoteUser>,
    searching: Boolean,
    onSearch: (String) -> Unit,
    onSelectUser: (RemoteUser) -> Unit,
    onBack: () -> Unit
) {
    var query by remember { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = { Text("Search Users") }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = {
                    query = it
                    onSearch(it)
                },
                label = { Text("Search by @username") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(12.dp))
            if (searching) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            LazyColumn {
                items(results, key = { it.uid }) { user ->
                    ListItem(
                        modifier = Modifier.clickable { onSelectUser(user) },
                        headlineContent = { Text(user.displayName, fontWeight = FontWeight.SemiBold) },
                        supportingContent = { Text("@${user.username}") },
                        trailingContent = {
                            Text(
                                text = if (user.online) "Online" else "Offline",
                                color = if (user.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelSmall
                            )
                        }
                    )
                    HorizontalDivider()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    profile: UserEntity?,
    onLogout: () -> Unit,
    onBack: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = { Text("Profile") }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp)) {
            Text(profile?.displayName ?: "Loading...", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Text("@${profile?.username ?: ""}", color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(20.dp))
            Text("Public Identity Key (ECDH P-256)", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.height(6.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = profile?.publicKey ?: "Keystore unavailable",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(12.dp)
                )
            }
            Spacer(Modifier.weight(1f))
            Button(
                onClick = onLogout,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth().height(48.dp)
            ) {
                Text("Secure Logout & Wipe Local Cache")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    darkMode: Boolean,
    metrics: DataMetricEntity,
    networkType: NetworkType,
    onToggleDarkMode: () -> Unit,
    onResetMetrics: () -> Unit,
    onBack: () -> Unit
) {
    val totalExact = metrics.bytesSentExact + metrics.bytesReceivedExact
    val totalWithEstOverhead = totalExact + metrics.estimatedOverheadBytes

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = { Text("Settings & Data Monitor") }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(20.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text("Dark Mode", style = MaterialTheme.typography.titleMedium)
                    Text("Reduces OLED power draw", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked = darkMode, onCheckedChange = { onToggleDarkMode() })
            }

            Spacer(Modifier.height(20.dp))
            HorizontalDivider()
            Spacer(Modifier.height(20.dp))

            Text("Data Consumption Monitor", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            MetricRow("Connection Status", networkType.name)
            MetricRow("Payload Sent (Exact)", "${metrics.bytesSentExact} B")
            MetricRow("Payload Received (Exact)", "${metrics.bytesReceivedExact} B")
            MetricRow("Est. TLS/TCP Overhead", "${metrics.estimatedOverheadBytes} B (Estimated)")
            MetricRow("Total Messaging Data", "${totalWithEstOverhead} B (${"%.2f".format(totalWithEstOverhead / 1024.0)} KB)")
            MetricRow("Messages Sent", "${metrics.messagesSentCount}")
            MetricRow("Messages Received", "${metrics.messagesReceivedCount}")

            Spacer(Modifier.height(12.dp))
            Text(
                "Note: Application JSON/ciphertext bytes are exact UTF-8 measurements. TLS/TCP packet headers are estimated (~64 B/exchange). Standard carrier pay-per-use rates apply on cellular SIMs without a data promo.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(Modifier.height(16.dp))
            OutlinedButton(onClick = onResetMetrics, modifier = Modifier.fillMaxWidth()) {
                Text("Reset Counters")
            }
        }
    }
}

@Composable
private fun MetricRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
    }
}
