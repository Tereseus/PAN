@echo off
cd /d C:\Users\tzuri\Desktop\PAN\android
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
rmdir /s /q app\build 2>nul
C:\Users\tzuri\Desktop\PAN\android\gradlew.bat assembleDebug
