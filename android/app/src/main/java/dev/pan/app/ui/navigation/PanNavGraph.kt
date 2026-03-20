package dev.pan.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.pan.app.ui.main.MainScreen
import dev.pan.app.ui.settings.SettingsScreen
import dev.pan.app.ui.conversation.ConversationScreen
import dev.pan.app.ui.commands.CommandsScreen
import dev.pan.app.ui.dashboard.DashboardScreen

sealed class Screen(val route: String) {
    data object Main : Screen("main")
    data object Settings : Screen("settings")
    data object Conversation : Screen("conversation")
    data object Commands : Screen("commands")
    data object Dashboard : Screen("dashboard")
}

@Composable
fun PanNavGraph() {
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = Screen.Main.route) {
        composable(Screen.Main.route) {
            MainScreen(
                onNavigateToSettings = { navController.navigate(Screen.Settings.route) },
                onNavigateToConversation = { navController.navigate(Screen.Conversation.route) },
                onNavigateToCommands = { navController.navigate(Screen.Commands.route) },
                onNavigateToDashboard = { navController.navigate(Screen.Dashboard.route) }
            )
        }
        composable(Screen.Settings.route) {
            SettingsScreen(onBack = { navController.popBackStack() })
        }
        composable(Screen.Conversation.route) {
            ConversationScreen(onBack = { navController.popBackStack() })
        }
        composable(Screen.Commands.route) {
            CommandsScreen(onBack = { navController.popBackStack() })
        }
        composable(Screen.Dashboard.route) {
            DashboardScreen(onBack = { navController.popBackStack() })
        }
    }
}
