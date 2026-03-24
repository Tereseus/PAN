package dev.pan.app.di

import android.content.Context
import androidx.room.Room
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.pan.app.ai.LocalLlm
import dev.pan.app.data.PanDatabase
import dev.pan.app.data.dao.*
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): PanDatabase {
        return Room.databaseBuilder(context, PanDatabase::class.java, "pan.db")
            .fallbackToDestructiveMigration()
            .build()
    }

    @Provides
    fun providePendingUploadDao(db: PanDatabase): PendingUploadDao = db.pendingUploadDao()

    @Provides
    fun provideConversationDao(db: PanDatabase): ConversationDao = db.conversationDao()

    @Provides
    fun provideSettingsDao(db: PanDatabase): SettingsDao = db.settingsDao()

    @Provides
    @Singleton
    fun provideLocalLlm(@ApplicationContext context: Context): LocalLlm = LocalLlm(context)
}
