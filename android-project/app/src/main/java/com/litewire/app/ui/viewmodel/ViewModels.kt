package com.litewire.app.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.litewire.app.data.local.entity.ConversationEntity
import com.litewire.app.data.local.entity.DataMetricEntity
import com.litewire.app.data.local.entity.MessageEntity
import com.litewire.app.data.local.entity.UserEntity
import com.litewire.app.data.remote.RemoteUser
import com.litewire.app.data.repository.MessagingRepository
import com.litewire.app.util.NetworkType
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class AuthUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val authenticated: Boolean = false
)

class MainViewModel(private val repo: MessagingRepository) : ViewModel() {

    private val _authState = MutableStateFlow(
        AuthUiState(authenticated = repo.currentUid() != null)
    )
    val authState: StateFlow<AuthUiState> = _authState.asStateFlow()

    private val _darkMode = MutableStateFlow(false)
    val darkMode: StateFlow<Boolean> = _darkMode.asStateFlow()

    private val _profile = MutableStateFlow<UserEntity?>(null)
    val profile: StateFlow<UserEntity?> = _profile.asStateFlow()

    private val _searchResults = MutableStateFlow<List<RemoteUser>>(emptyList())
    val searchResults: StateFlow<List<RemoteUser>> = _searchResults.asStateFlow()

    private val _searching = MutableStateFlow(false)
    val searching: StateFlow<Boolean> = _searching.asStateFlow()

    private val _pageLimit = MutableStateFlow(30)

    val conversations: StateFlow<List<ConversationEntity>> = repo.observeConversations()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val pendingCount: StateFlow<Int> = repo.observePendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    val dataMetrics: StateFlow<DataMetricEntity> = repo.observeDataMetrics()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), DataMetricEntity())

    val networkType: StateFlow<NetworkType> = repo.observeNetworkType()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), NetworkType.OFFLINE)

    private var convoSyncJob: Job? = null
    private var activeChatSyncJob: Job? = null

    init {
        if (repo.currentUid() != null) {
            startBackgroundSync()
        }
    }

    fun currentUid(): String? = repo.currentUid()

    fun toggleDarkMode() {
        _darkMode.value = !_darkMode.value
    }

    fun clearAuthError() {
        _authState.value = _authState.value.copy(error = null)
    }

    fun register(username: String, displayName: String, email: String, password: String) {
        viewModelScope.launch {
            _authState.value = AuthUiState(loading = true)
            runCatching {
                repo.register(username, displayName, email, password)
            }.onSuccess {
                _authState.value = AuthUiState(authenticated = true)
                startBackgroundSync()
            }.onFailure { err ->
                _authState.value = AuthUiState(error = err.message ?: "Registration failed.")
            }
        }
    }

    fun login(email: String, password: String) {
        viewModelScope.launch {
            _authState.value = AuthUiState(loading = true)
            runCatching {
                repo.login(email, password)
            }.onSuccess {
                _authState.value = AuthUiState(authenticated = true)
                startBackgroundSync()
            }.onFailure { err ->
                _authState.value = AuthUiState(error = err.message ?: "Login failed.")
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            convoSyncJob?.cancel()
            activeChatSyncJob?.cancel()
            repo.logout()
            _profile.value = null
            _authState.value = AuthUiState(authenticated = false)
        }
    }

    fun loadProfile() {
        viewModelScope.launch {
            _profile.value = repo.getCurrentUserProfile()
        }
    }

    fun searchUsers(query: String) {
        viewModelScope.launch {
            _searching.value = true
            _searchResults.value = runCatching { repo.searchUsers(query) }.getOrDefault(emptyList())
            _searching.value = false
        }
    }

    fun openConversationWithUser(peer: RemoteUser, onOpened: (String) -> Unit) {
        viewModelScope.launch {
            val id = repo.startOrGetConversation(peer)
            onOpened(id)
        }
    }

    fun observeConversation(conversationId: String) = repo.observeConversation(conversationId)

    fun observeMessages(conversationId: String) =
        repo.observeMessagesPaged(conversationId, _pageLimit.value)

    fun loadMoreMessages() {
        _pageLimit.value += 30
    }

    fun startChatSync(conversationId: String) {
        activeChatSyncJob?.cancel()
        _pageLimit.value = 30
        activeChatSyncJob = viewModelScope.launch {
            repo.syncIncomingMessages(conversationId)
        }
    }

    fun stopChatSync() {
        activeChatSyncJob?.cancel()
    }

    fun sendMessage(conversationId: String, text: String) {
        viewModelScope.launch {
            repo.sendMessage(conversationId, text)
        }
    }

    fun markRead(conversationId: String, messages: List<MessageEntity>) {
        viewModelScope.launch {
            repo.markConversationRead(conversationId, messages)
        }
    }

    fun deleteMessageLocally(messageId: String) {
        viewModelScope.launch {
            repo.deleteMessageLocally(messageId)
        }
    }

    fun clearConversationLocally(conversationId: String) {
        viewModelScope.launch {
            repo.clearConversationLocally(conversationId)
        }
    }

    fun safetyFingerprint(peerPublicKey: String): String =
        repo.computeSafetyFingerprint(peerPublicKey)

    fun resetBandwidthMetrics() {
        viewModelScope.launch {
            repo.bandwidth.resetMetrics()
        }
    }

    private fun startBackgroundSync() {
        loadProfile()
        convoSyncJob?.cancel()
        convoSyncJob = viewModelScope.launch {
            repo.flushPendingQueue()
            repo.syncConversationMetadata()
        }
    }

    class Factory(private val repo: MessagingRepository) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return MainViewModel(repo) as T
        }
    }
}
