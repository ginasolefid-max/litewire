package com.litewire.app

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.litewire.app.ui.screens.*
import com.litewire.app.ui.theme.LiteWireTheme
import com.litewire.app.ui.viewmodel.MainViewModel

class MainActivity : ComponentActivity() {

    private val requestNotifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val app = application as LiteWireApplication
        val factory = MainViewModel.Factory(app.repository)

        setContent {
            val vm: MainViewModel = viewModel(factory = factory)
            val authState by vm.authState.collectAsState()
            val darkMode by vm.darkMode.collectAsState()
            val conversations by vm.conversations.collectAsState()
            val pendingCount by vm.pendingCount.collectAsState()
            val metrics by vm.dataMetrics.collectAsState()
            val networkType by vm.networkType.collectAsState()
            val profile by vm.profile.collectAsState()
            val searchResults by vm.searchResults.collectAsState()
            val searching by vm.searching.collectAsState()

            LiteWireTheme(darkTheme = darkMode) {
                val nav = rememberNavController()

                NavHost(navController = nav, startDestination = "splash") {
                    composable("splash") {
                        SplashScreen(
                            isAuthenticated = authState.authenticated,
                            onNavigateAuthenticated = {
                                nav.navigate("conversations") { popUpTo("splash") { inclusive = true } }
                            },
                            onNavigateLogin = {
                                nav.navigate("login") { popUpTo("splash") { inclusive = true } }
                            }
                        )
                    }

                    composable("login") {
                        LaunchedEffect(authState.authenticated) {
                            if (authState.authenticated) {
                                nav.navigate("conversations") { popUpTo("login") { inclusive = true } }
                            }
                        }
                        LoginScreen(
                            authState = authState,
                            onLogin = { email, pass -> vm.login(email, pass) },
                            onGoRegister = {
                                vm.clearAuthError()
                                nav.navigate("register")
                            }
                        )
                    }

                    composable("register") {
                        LaunchedEffect(authState.authenticated) {
                            if (authState.authenticated) {
                                nav.navigate("conversations") { popUpTo("register") { inclusive = true } }
                            }
                        }
                        RegisterScreen(
                            authState = authState,
                            onRegister = { u, d, e, p -> vm.register(u, d, e, p) },
                            onGoLogin = {
                                vm.clearAuthError()
                                nav.popBackStack()
                            }
                        )
                    }

                    composable("conversations") {
                        ConversationListScreen(
                            conversations = conversations,
                            pendingCount = pendingCount,
                            networkType = networkType,
                            onOpenChat = { id -> nav.navigate("chat/$id") },
                            onOpenSearch = { nav.navigate("search") },
                            onOpenProfile = {
                                vm.loadProfile()
                                nav.navigate("profile")
                            },
                            onOpenSettings = { nav.navigate("settings") }
                        )
                    }

                    composable(
                        route = "chat/{conversationId}",
                        arguments = listOf(navArgument("conversationId") { type = NavType.StringType })
                    ) { backStack ->
                        val convoId = backStack.arguments?.getString("conversationId") ?: ""
                        val convo by vm.observeConversation(convoId).collectAsState(initial = null)
                        val msgs by vm.observeMessages(convoId).collectAsState(initial = emptyList())

                        LaunchedEffect(convoId) {
                            vm.startChatSync(convoId)
                        }
                        LaunchedEffect(msgs.size) {
                            vm.markRead(convoId, msgs)
                        }

                        ChatScreen(
                            conversation = convo,
                            messages = msgs,
                            myUid = vm.currentUid() ?: "",
                            networkType = networkType,
                            fingerprint = convo?.let { vm.safetyFingerprint(it.peerPublicKey) } ?: "",
                            onBack = {
                                vm.stopChatSync()
                                nav.popBackStack()
                            },
                            onSend = { text -> vm.sendMessage(convoId, text) },
                            onLoadMore = { vm.loadMoreMessages() },
                            onDeleteLocal = { id -> vm.deleteMessageLocally(id) },
                            onClearHistory = { vm.clearConversationLocally(convoId) }
                        )
                    }

                    composable("search") {
                        UserSearchScreen(
                            results = searchResults,
                            searching = searching,
                            onSearch = { q -> vm.searchUsers(q) },
                            onSelectUser = { peer ->
                                vm.openConversationWithUser(peer) { convoId ->
                                    nav.navigate("chat/$convoId") {
                                        popUpTo("search") { inclusive = true }
                                    }
                                }
                            },
                            onBack = { nav.popBackStack() }
                        )
                    }

                    composable("profile") {
                        ProfileScreen(
                            profile = profile,
                            onLogout = {
                                vm.logout()
                                nav.navigate("login") { popUpTo("conversations") { inclusive = true } }
                            },
                            onBack = { nav.popBackStack() }
                        )
                    }

                    composable("settings") {
                        SettingsScreen(
                            darkMode = darkMode,
                            metrics = metrics,
                            networkType = networkType,
                            onToggleDarkMode = { vm.toggleDarkMode() },
                            onResetMetrics = { vm.resetBandwidthMetrics() },
                            onBack = { nav.popBackStack() }
                        )
                    }
                }
            }
        }
    }
}
