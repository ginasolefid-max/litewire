package com.litewire.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.MessageStatus
import com.litewire.app.util.NetworkType
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(
    conversation: ConversationEntity?,
    messages: List<MessageEntity>,
    myUid: String,
    networkType: NetworkType,
    fingerprint: String,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onLoadMore: () -> Unit,
    onDeleteLocal: (String) -> Unit,
    onClearHistory: () -> Unit
) {
    var draft by remember { mutableStateOf("") }
    var showFingerprintDialog by remember { mutableStateOf(false) }

    if (showFingerprintDialog) {
        AlertDialog(
            onDismissRequest = { showFingerprintDialog = false },
            title = { Text("End-to-End Encryption") },
            text = {
                Text("Safety fingerprint (ECDH P-256 + AES-256-GCM):\n\n$fingerprint\n\nVerify this code matches your contact's screen.")
            },
            confirmButton = {
                TextButton(onClick = { showFingerprintDialog = false }) { Text("Close") }
            }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(conversation?.peerDisplayName ?: "Chat", fontWeight = FontWeight.SemiBold)
                        Text(
                            text = if (conversation?.peerOnline == true) "Online · E2EE" else "Offline · E2EE",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showFingerprintDialog = true }) {
                        Icon(Icons.Default.Lock, contentDescription = "Verify Encryption")
                    }
                    IconButton(onClick = onClearHistory) {
                        Icon(Icons.Default.DeleteSweep, contentDescription = "Clear Local History")
                    }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (networkType == NetworkType.OFFLINE) {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = "Offline mode: messages are encrypted & queued locally until internet returns.",
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
            }

            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
                reverseLayout = true
            ) {
                items(messages, key = { it.messageId }) { msg ->
                    val isMine = msg.senderId == myUid
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start
                    ) {
                        Surface(
                            color = if (isMine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = if (isMine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier
                                .widthIn(max = 290.dp)
                                .combinedClickable(
                                    onClick = {},
                                    onLongClick = { onDeleteLocal(msg.messageId) }
                                )
                        ) {
                            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                                Text(msg.plaintext, style = MaterialTheme.typography.bodyMedium)
                                Spacer(Modifier.height(4.dp))
                                val statusLabel = if (isMine) {
                                    when (msg.status) {
                                        MessageStatus.PENDING -> " · Pending"
                                        MessageStatus.SENT -> " · Sent"
                                        MessageStatus.DELIVERED -> " · Delivered"
                                        MessageStatus.READ -> " · Read"
                                    }
                                } else ""
                                Text(
                                    text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(msg.timestamp)) + statusLabel,
                                    style = MaterialTheme.typography.labelSmall
                                )
                            }
                        }
                    }
                }

                if (messages.size >= 30) {
                    item {
                        TextButton(
                            onClick = onLoadMore,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Load older messages")
                        }
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = { Text("Encrypted text message...") },
                    modifier = Modifier.weight(1f),
                    maxLines = 4
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = {
                        if (draft.isNotBlank()) {
                            onSend(draft)
                            draft = ""
                        }
                    },
                    modifier = Modifier.size(48.dp)
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        }
    }
}
