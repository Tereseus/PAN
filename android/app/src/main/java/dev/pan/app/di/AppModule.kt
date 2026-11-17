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
            // 1 -> 2 (0.5.1): a photo beside an answer. A real migration, so the phone's settings
            // and its unsent queue survive the update (the fallback below would wipe them).
            .addMigrations(object : androidx.room.migration.Migration(1, 2) {
                override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                    db.execSQL("ALTER TABLE conversations ADD COLUMN photo TEXT")
                }
            })
            // 2 -> 3 (0.5.7): how long a reply took and where the time went.
            .addMigrations(object : androidx.room.migration.Migration(2, 3) {
                override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                    db.execSQL("ALTER TABLE conversations ADD COLUMN ms INTEGER")
                    db.execSQL("ALTER TABLE conversations ADD COLUMN detail TEXT")
                }
            })
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
