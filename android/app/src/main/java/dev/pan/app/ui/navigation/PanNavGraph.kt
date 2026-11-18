package dev.pan.app.ui.navigation

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.pan.app.ui.dashboard.DashboardScreen
import dev.pan.app.ui.home.HomeScreen
import dev.pan.app.ui.main.MainViewModel
import dev.pan.app.ui.memory.MemoryScreen
import dev.pan.app.ui.people.CallStrip
import dev.pan.app.ui.people.PeopleScreen
import dev.pan.app.ui.people.PeopleViewModel
import dev.pan.app.ui.settings.SettingsScreen

sealed class Screen(val route: String) {
    data object Home : Screen("home")
    data object People : Screen("people")
    data object Memory : Screen("memory")
    data object Settings : Screen("settings")
    // Tools for building PAN. Reached from Settings, with the developer switch on.
    data object Dashboard : Screen("dashboard")
}

private data class Tab(val screen: Screen, val label: String, val icon: ImageVector)

private val TABS = listOf(
    Tab(Screen.Home, "Home", Icons.Default.Home),
    Tab(Screen.People, "People", Icons.Default.Person),
    Tab(Screen.Memory, "Memory", Icons.Default.Search),
    Tab(Screen.Settings, "Settings", Icons.Default.Settings),
)

/**
 * The app's frame (docs/MOBILE-APP-PLAN.md): four tabs. Home is the talk and the mic, People is
 * everyone else on this ΠAN and the messages with each (since 0.5.17), Memory is what PAN kept,
 * Settings is everything you set once. The hub's web page is still here, behind the developer
 * switch in Settings, shown without the tab bar. (The command log went in 0.5.29: a debug list of
 * typed questions that Home already shows.)
 */
@Composable
fun PanNavGraph() {
    val navController = rememberNavController()
    // One for the whole app (its owner here is the activity): Home and Settings both read it, and
    // its polling loops must not run twice.
    val mainViewModel: MainViewModel = hiltViewModel()
    // Also one for the whole app: the People tab's mark shows on every tab.
    val peopleViewModel: PeopleViewModel = hiltViewModel()
    val newMessages by peopleViewModel.unread.collectAsState()
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
                            icon = {
                                if (tab.screen == Screen.People && newMessages > 0) {
                                    BadgedBox(badge = { Badge { Text(if (newMessages > 99) "99+" else "$newMessages") } }) {
                                        Icon(tab.icon, contentDescription = null)
                                    }
                                } else Icon(tab.icon, contentDescription = null)
                            },
                            label = { Text(tab.label) }
                        )
                    }
                }
            }
        }
    ) { inner ->
        // A call shows on every tab, not only People: who is calling, with Answer and Not now.
        val talkWith by peopleViewModel.talkWith.collectAsState()
        val callingMe by peopleViewModel.callingMe.collectAsState()
        val roomOn by peopleViewModel.roomOn.collectAsState()
        val roomsRinging by peopleViewModel.roomsRinging.collectAsState()
        val inCall = talkWith != 0 || callingMe != 0 || roomOn != null || roomsRinging.isNotEmpty()
        LaunchedEffect(inCall, route) {
            // While a call is open or ringing, keep its state fresh off the People tab too.
            while (inCall && route != Screen.People.route) {
                kotlinx.coroutines.delay(3000)
                peopleViewModel.refresh()
            }
        }
        Box(modifier = Modifier.padding(inner).consumeWindowInsets(inner)) {
        NavHost(
            navController = navController,
            startDestination = Screen.Home.route,
        ) {
            composable(Screen.Home.route) { HomeScreen(viewModel = mainViewModel) }
            composable(Screen.People.route) { PeopleScreen(viewModel = peopleViewModel) }
            composable(Screen.Memory.route) { MemoryScreen() }
            composable(Screen.Settings.route) {
                SettingsScreen(
                    mainViewModel = mainViewModel,
                    onOpenDashboard = { navController.navigate(Screen.Dashboard.route) }
                )
            }
            composable(Screen.Dashboard.route) {
                DashboardScreen(onBack = { navController.popBackStack() })
            }
        }
        if (onTab && route != Screen.People.route) CallStrip(peopleViewModel,
            modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 8.dp, end = 12.dp))
        }
    }
}
