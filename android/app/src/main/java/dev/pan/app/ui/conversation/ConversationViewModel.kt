package dev.pan.app.ui.conversation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.data.DataRepository
import dev.pan.app.data.entity.ConversationEntity
import dev.pan.app.network.PanServerClient
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ConversationViewModel @Inject constructor(
    private val dataRepository: DataRepository,
    private val serverClient: PanServerClient
) : ViewModel() {

    val messages: StateFlow<List<ConversationEntity>> = dataRepository.getRecentConversations()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(), emptyList())

    fun sendMessage(text: String) {
        viewModelScope.launch {
            // Save user message locally
            dataRepository.addUserMessage(text)

            // Send to PAN server
            val response = serverClient.askPan(text)
            if (response != null) {
                dataRepository.addPanResponse(response.response_text)
            } else {
                dataRepository.addPanResponse("[PAN is offline — message queued]")
            }
        }
    }
}
