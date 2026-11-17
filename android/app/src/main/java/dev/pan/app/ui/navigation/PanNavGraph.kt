package dev.pan.app.ui.navigation

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.pan.app.ui.commands.CommandsScreen
import dev.pan.app.ui.dashboard.DashboardScreen
import dev.pan.app.ui.home.HomeScreen
import dev.pan.app.ui.main.MainViewModel
import dev.pan.app.ui.memory.MemoryScreen
import dev.pan.app.ui.settings.SettingsScreen

sealed class Screen(val route: String) {
    data object Home : Screen("home")
    data object Memory : Screen("memory")
    data object Settings : Screen("settings")
    // Tools for building PAN. Reached from Settings, with the developer switch on.
    data object Commands : Screen("commands")
    data object Dashboard : Screen("dashboard")
}

private data class Tab(val screen: Screen, val label: String, val icon: ImageVector)

private val TABS = listOf(
    Tab(Screen.Home, "Home", Icons.Default.Home),
    Tab(Screen.Memory, "Memory", Icons.Default.Search),
    Tab(Screen.Settings, "Settings", Icons.Default.Settings),
)

/**
 * The app's frame since 0.5.1 (docs/MOBILE-APP-PLAN.md): three tabs. Home is the talk and the mic,
 * Memory is what PAN kept, Settings is everything you set once. The web dashboard and the command
 * log are still here, behind the developer switch in Settings, shown without the tab bar.
 */
@Composable
fun PanNavGraph() {
    val navController = rememberNavController()
    // One for the whole app (its owner here is the activity): Home and Settings both read it, and
    // its polling loops must not run twice.
    val mainViewModel: MainViewModel = hiltViewModel()
    val entry by navController.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val onTab = route == null || TABS.any { it.screen.route == route }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            if (onTab) {
                NavigationBar {
                    TABS.forEach { tab ->
                        NavigationBarItem(
                            selected = route == tab.screen.route,
                            onClick = {
                                navController.navigate(tab.screen.route) {
                                    popUpTo(navController.graph.findStartDestination().id)
                                    launchSingleTop = true
                                }
                            },
                            icon = { Icon(tab.icon, contentDescription = null) },
                            label = { Text(tab.label) }
                        )
                    }
                }
            }
        }
    ) { inner ->
        NavHost(
            navController = navController,
            startDestination = Screen.Home.route,
            modifier = Modifier.padding(inner).consumeWindowInsets(inner)
        ) {
            composable(Screen.Home.route) { HomeScreen(viewModel = mainViewModel) }
            composable(Screen.Memory.route) { MemoryScreen() }
            composable(Screen.Settings.route) {
                SettingsScreen(
                    mainViewModel = mainViewModel,
                    onOpenDashboard = { navController.navigate(Screen.Dashboard.route) },
                    onOpenCommands = { navController.navigate(Screen.Commands.route) }
                )
            }
            composable(Screen.Commands.route) {
                CommandsScreen(onBack = { navController.popBackStack() })
            }
            composable(Screen.Dashboard.route) {
                DashboardScreen(onBack = { navController.popBackStack() })
            }
        }
    }
}
