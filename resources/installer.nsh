; Maris installer extras (electron-builder includes this file, see nsis.include in electron-builder.yml).
;
; An "Extras" page after the folder choice offers:
;   - a desktop shortcut,
;   - the maris terminal command on PATH (bin\maris.exe),
;   - "Open in Maris" in the right-click menu of folders (opens the folder in Code mode),
;   - starting Maris in the background when Windows starts.
; The choices are remembered for the next installer (updates keep them) and undone on uninstall.
;
; Also: the Back, Next and Cancel buttons are spaced evenly, and while files are copied the page says what
; is happening (and what happens next) instead of showing a bare progress bar. Labels keep the system's
; text colours, so they stay readable with dark dialog themes too.

!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh
!include StrFunc.nsh

!define MARIS_OPTIONS_KEY "Software\Maris\InstallOptions"
!define MARIS_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; Tests (tests/installer/path-test.nsi) point these at a scratch key instead of the real PATH.
!ifndef MARIS_USER_ENV
  !define MARIS_USER_ENV "Environment"
!endif
!ifndef MARIS_MACHINE_ENV
  !define MARIS_MACHINE_ENV "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
!endif
; Electron writes its login item under the app's user model id; the app reads the same value back.
!define MARIS_RUN_VALUE "${APP_ID}"

; Windows puts Back and Next side by side with a gap before Cancel; space all three evenly instead.
; (A macro, so the installer and the uninstaller each get their own copy of the function.)
!macro MARIS_SPACE_BUTTONS
  GetDlgItem $0 $HWNDPARENT 3
  GetDlgItem $1 $HWNDPARENT 1
  GetDlgItem $2 $HWNDPARENT 2
  System::Call '*(i,i,i,i)p.r3'
  System::Call 'user32::GetWindowRect(p r1, p r3)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r3, i 2)'
  System::Call '*$3(i.r4,i.r5,i.r6,i)'
  System::Call 'user32::GetWindowRect(p r2, p r3)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r3, i 2)'
  System::Call '*$3(i.r7,i,i,i)'
  System::Free $3
  ; Next to Cancel is the gap to copy; Back moves left by it.
  IntOp $8 $7 - $6
  IntOp $9 $6 - $4
  ${If} $8 > 0
    IntOp $R0 $4 - $8
    IntOp $R0 $R0 - $9
    ; SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    System::Call 'user32::SetWindowPos(p r0, p 0, i R0, i r5, i 0, i 0, i 0x15)'
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  ${StrStr}

  !define MUI_CUSTOMFUNCTION_GUIINIT MarisGuiInit

  Var MarisDesktop
  Var MarisPath
  Var MarisFolderMenu
  Var MarisStartup
  Var MarisChkDesktop
  Var MarisChkPath
  Var MarisChkFolderMenu
  Var MarisChkStartup
  Var MarisSkipPage
  Var MarisPlan

  !macro customInit
    ; Updates started by the app keep the earlier choices without asking again. (Checked here, not in the
    ; page function: this file is read before electron-builder registers the plugin that tests it.)
    StrCpy $MarisSkipPage 0
    ${If} ${isUpdated}
      StrCpy $MarisSkipPage 1
    ${EndIf}
    ; Defaults for a first install; later installs start from the previous choices.
    StrCpy $MarisDesktop 1
    StrCpy $MarisPath 1
    StrCpy $MarisFolderMenu 1
    StrCpy $MarisStartup 0
    ClearErrors
    ReadRegDWORD $0 HKCU "${MARIS_OPTIONS_KEY}" "Desktop"
    ${IfNot} ${Errors}
      StrCpy $MarisDesktop $0
      ReadRegDWORD $MarisPath HKCU "${MARIS_OPTIONS_KEY}" "Path"
      ReadRegDWORD $MarisFolderMenu HKCU "${MARIS_OPTIONS_KEY}" "FolderMenu"
      ReadRegDWORD $MarisStartup HKCU "${MARIS_OPTIONS_KEY}" "Startup"
    ${EndIf}
  !macroend

  ; The page and its functions are defined here, not at the top of this file: electron-builder reads this
  ; file before MUI2 and its plugins are loaded, and expands this macro after them.
  !macro customPageAfterChangeDir
    Page custom MarisExtrasPage MarisExtrasLeave

    Function MarisGuiInit
      !insertmacro MARIS_SPACE_BUTTONS
    FunctionEnd

    ; The copying page: a line above the progress bar, and below it what is happening and what comes next.
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW MarisInstFilesShow
    Function MarisInstFilesShow
      FindWindow $R0 "#32770" "" $HWNDPARENT
      GetDlgItem $R1 $R0 1006
      ${If} $MarisSkipPage == 1
        SendMessage $R1 ${WM_SETTEXT} 0 "STR:Updating Maris…"
      ${Else}
        SendMessage $R1 ${WM_SETTEXT} 0 "STR:Copying Maris to your PC…"
      ${EndIf}

      StrCpy $R3 "Maris is being copied to $INSTDIR"
      !ifdef APP_64_UNPACKED_SIZE
        IntOp $R4 ${APP_64_UNPACKED_SIZE} / 1024
        StrCpy $R3 "$R3 (about $R4 MB)"
      !endif
      StrCpy $R3 "$R3. This takes a minute or two; nothing is downloaded.$\r$\n$\r$\nThen:"
      StrCpy $R3 "$R3$\r$\n    •  Maris is added to the Start menu and to Apps in Settings"
      ${If} $MarisPath == 1
        StrCpy $R3 "$R3$\r$\n    •  the maris command is added, for Terminal, PowerShell and Command Prompt"
      ${EndIf}
      ${If} $MarisDesktop == 1
        StrCpy $R3 "$R3$\r$\n    •  a shortcut is put on your desktop"
      ${EndIf}
      ${If} $MarisFolderMenu == 1
        StrCpy $R3 "$R3$\r$\n    •  $\"Open in Maris$\" is added to the right-click menu of folders"
      ${EndIf}
      ${If} $MarisStartup == 1
        StrCpy $R3 "$R3$\r$\n    •  Maris starts in the background when you sign in"
      ${EndIf}
      StrCpy $R3 "$R3$\r$\n$\r$\nNothing else on your PC changes. Uninstalling removes all of it again."

      ; Under the progress bar, as wide as it, down to the bottom of the page.
      GetDlgItem $R5 $R0 1004
      System::Call '*(i,i,i,i)p.r6'
      System::Call 'user32::GetWindowRect(p R5, p r6)'
      System::Call 'user32::MapWindowPoints(p 0, p R0, p r6, i 2)'
      System::Call '*$6(i.r7,i,i.r9,i.R6)'
      System::Call 'user32::GetClientRect(p R0, p r6)'
      System::Call '*$6(i,i,i,i.R7)'
      System::Free $6
      IntOp $R8 $R6 + 16
      IntOp $9 $9 - $7
      IntOp $R7 $R7 - $R8
      System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R3, i 0x50000000, i r7, i R8, i r9, i R7, p R0, p 0, p 0, p 0) p.R9'
      StrCpy $MarisPlan $R9
      SendMessage $R0 ${WM_GETFONT} 0 0 $R4
      SendMessage $MarisPlan ${WM_SETFONT} $R4 1
      ; The details list and its button are never used here; the description takes their place.
      GetDlgItem $R2 $R0 1027
      ShowWindow $R2 ${SW_HIDE}
      GetDlgItem $R2 $R0 1016
      ShowWindow $R2 ${SW_HIDE}
    FunctionEnd

    Function MarisExtrasPage
      ${If} $MarisSkipPage == 1
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Extras" "Choose what else to set up. You can change these later in Maris → Settings."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateCheckbox} 0 0 100% 12u "Create a &desktop shortcut"
      Pop $MarisChkDesktop

      ${NSD_CreateCheckbox} 0 22u 100% 12u "Add the &maris command, to chat from Terminal, PowerShell or Command Prompt"
      Pop $MarisChkPath
      ${NSD_CreateLabel} 13u 35u -13u 18u "Adds Maris's bin folder to PATH. Open a new terminal window and type: maris $\"how much space is left on C:?$\""
      Pop $0

      ${NSD_CreateCheckbox} 0 60u 100% 12u "Add $\"&Open in Maris$\" to the right-click menu of folders"
      Pop $MarisChkFolderMenu
      ${NSD_CreateLabel} 13u 73u -13u 18u "Opens the folder as a project in Code mode. On Windows 11 it is under $\"Show more options$\"."
      Pop $0

      ${NSD_CreateCheckbox} 0 98u 100% 12u "&Start Maris in the background when I sign in"
      Pop $MarisChkStartup
      ${NSD_CreateLabel} 13u 111u -13u 18u "It waits in the tray, so answers and the maris command start without delay."
      Pop $0

      ${If} $MarisDesktop == 1
        ${NSD_Check} $MarisChkDesktop
      ${EndIf}
      ${If} $MarisPath == 1
        ${NSD_Check} $MarisChkPath
      ${EndIf}
      ${If} $MarisFolderMenu == 1
        ${NSD_Check} $MarisChkFolderMenu
      ${EndIf}
      ${If} $MarisStartup == 1
        ${NSD_Check} $MarisChkStartup
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function MarisExtrasLeave
      ${NSD_GetState} $MarisChkDesktop $MarisDesktop
      ${NSD_GetState} $MarisChkPath $MarisPath
      ${NSD_GetState} $MarisChkFolderMenu $MarisFolderMenu
      ${NSD_GetState} $MarisChkStartup $MarisStartup
    FunctionEnd

    ; Append $INSTDIR\bin to PATH (the user's, or everyone's for a per-machine install).
    Function MarisAddToPath
      StrCpy $R0 "$INSTDIR\bin"
      ${If} $installMode == "all"
        ReadRegStr $R1 HKLM "${MARIS_MACHINE_ENV}" "Path"
      ${Else}
        ReadRegStr $R1 HKCU "${MARIS_USER_ENV}" "Path"
      ${EndIf}
      StrLen $R2 $R1
      ; Never write back a value that might have been cut short when it was read.
      ${If} $R2 > 7900
        DetailPrint "PATH is very long, so it was left unchanged. Turn on the maris command in Maris → Settings → Window and startup."
        Return
      ${EndIf}
      ${StrStr} $R3 ";$R1;" ";$R0;"
      ${If} $R3 != ""
        Return
      ${EndIf}
      ${StrStr} $R3 ";$R1;" ";$R0\;"
      ${If} $R3 != ""
        Return
      ${EndIf}
      ${If} $R1 == ""
        StrCpy $R1 "$R0"
      ${Else}
        StrCpy $R3 $R1 1 -1
        ${If} $R3 == ";"
          StrCpy $R1 "$R1$R0"
        ${Else}
          StrCpy $R1 "$R1;$R0"
        ${EndIf}
      ${EndIf}
      ${If} $installMode == "all"
        WriteRegExpandStr HKLM "${MARIS_MACHINE_ENV}" "Path" $R1
      ${Else}
        WriteRegExpandStr HKCU "${MARIS_USER_ENV}" "Path" $R1
      ${EndIf}
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
      DetailPrint "Added $R0 to PATH."
    FunctionEnd
  !macroend



  !macro customInstall
    ; The files are in place; say what happens now on the line above the progress bar.
    SetDetailsPrint textonly
    DetailPrint "Setting up the extras you chose…"
    ; Remember the choices for the next installer.
    WriteRegDWORD HKCU "${MARIS_OPTIONS_KEY}" "Desktop" $MarisDesktop
    WriteRegDWORD HKCU "${MARIS_OPTIONS_KEY}" "Path" $MarisPath
    WriteRegDWORD HKCU "${MARIS_OPTIONS_KEY}" "FolderMenu" $MarisFolderMenu
    WriteRegDWORD HKCU "${MARIS_OPTIONS_KEY}" "Startup" $MarisStartup
    WriteRegStr HKCU "${MARIS_OPTIONS_KEY}" "InstallLocation" "$INSTDIR"

    ${If} $MarisDesktop == 1
      DetailPrint "Putting a shortcut on your desktop…"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${Else}
      Delete "$newDesktopLink"
    ${EndIf}

    ${If} $MarisPath == 1
      ${If} ${FileExists} "$INSTDIR\bin\maris.exe"
        DetailPrint "Adding the maris command…"
        Call MarisAddToPath
      ${EndIf}
    ${EndIf}

    ${If} $MarisFolderMenu == 1
      DetailPrint "Adding $\"Open in Maris$\" to folder menus…"
      WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\Maris" "" "Open in Maris"
      WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\Maris" "Icon" '"$appExe",0'
      WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\Maris\command" "" '"$appExe" --open-project "%V"'
      WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\Maris" "" "Open in Maris"
      WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\Maris" "Icon" '"$appExe",0'
      WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\Maris\command" "" '"$appExe" --open-project "%V"'
    ${Else}
      DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\shell\Maris"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\Background\shell\Maris"
    ${EndIf}

    ${If} $MarisStartup == 1
      WriteRegStr HKCU "${MARIS_RUN_KEY}" "${MARIS_RUN_VALUE}" '"$appExe" --background'
    ${Else}
      DeleteRegValue HKCU "${MARIS_RUN_KEY}" "${MARIS_RUN_VALUE}"
    ${EndIf}
    DetailPrint "Finishing…"
    ${If} $MarisPlan != ""
      SendMessage $MarisPlan ${WM_SETTEXT} 0 "STR:Maris is installed in $INSTDIR.$\r$\n$\r$\nThe next page starts it. The first time, Maris looks at your PC and suggests AI models that suit it; nothing is downloaded until you choose."
    ${EndIf}
    SetDetailsPrint none
  !macroend
!else
  ${UnStrRep}

  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.MarisGuiInit
  Function un.MarisGuiInit
    !insertmacro MARIS_SPACE_BUTTONS
  FunctionEnd

  ; Take $INSTDIR\bin out of a PATH value again.
  !macro MarisStripPath ROOT KEY
    ReadRegStr $R1 ${ROOT} "${KEY}" "Path"
    StrLen $R2 $R1
    ${If} $R1 != ""
    ${AndIf} $R2 <= 7900
      StrCpy $R3 ";$R1;"
      ${UnStrRep} $R3 $R3 ";$INSTDIR\bin;" ";"
      ${UnStrRep} $R3 $R3 ";$INSTDIR\bin\;" ";"
      ; Drop the separators added above.
      StrCpy $R3 $R3 "" 1
      StrCpy $R3 $R3 -1
      ${If} $R3 != $R1
        WriteRegExpandStr ${ROOT} "${KEY}" "Path" $R3
        SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
      ${EndIf}
    ${EndIf}
  !macroend

  !macro customUnInstall
    ; Updates run the old uninstaller first: keep everything for the new version.
    ${IfNot} ${isUpdated}
      !insertmacro MarisStripPath HKCU "${MARIS_USER_ENV}"
      ${If} $installMode == "all"
        !insertmacro MarisStripPath HKLM "${MARIS_MACHINE_ENV}"
      ${EndIf}
      DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\shell\Maris"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\Background\shell\Maris"
      DeleteRegValue HKCU "${MARIS_RUN_KEY}" "${MARIS_RUN_VALUE}"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      DeleteRegKey HKCU "${MARIS_OPTIONS_KEY}"
    ${EndIf}
  !macroend
!endif
