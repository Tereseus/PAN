package dev.pan.app.ui.commands

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.network.PanServerApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class CommandsViewModel @Inject constructor(
    private val api: PanServerApi
) : ViewModel() {

    private val _commands = MutableStateFlow<List<CommandItem>>(emptyList())
    val commands: StateFlow<List<CommandItem>> = _commands

    private val _devices = MutableStateFlow<List<DeviceItem>>(emptyList())
    val devices: StateFlow<List<DeviceItem>> = _devices

    init {
        viewModelScope.launch {
            while (true) {
                refresh()
                delay(3000)
            }
        }
    }

    private suspend fun refresh() {
        try {
            val cmdRes = api.commandHistory()
            if (cmdRes.isSuccessful) {
                _commands.value = cmdRes.body() ?: emptyList()
            }
        } catch (_: Exception) {}

        try {
            val devRes = api.deviceList()
            if (devRes.isSuccessful) {
                _devices.value = devRes.body() ?: emptyList()
            }
        } catch (_: Exception) {}
    }

    fun getLogsFor(commandId: Long): Flow<List<LogItem>> = flow {
        try {
            val res = api.commandLogs(commandId)
            if (res.isSuccessful) {
                emit(res.body() ?: emptyList())
            } else {
                emit(emptyList())
            }
        } catch (_: Exception) {
            emit(emptyList())
        }
    }
}
