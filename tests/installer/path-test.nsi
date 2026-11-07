; Checks the installer's PATH handling (resources/installer.nsh) against a scratch registry key,
; never the real PATH. Built and run by tests/installer/check-path.cjs.
Unicode true
Name "Maris PATH test"
OutFile "${OUT}"
RequestExecutionLevel user
SilentInstall silent

!define MARIS_USER_ENV "Software\MarisInstallerTest\Environment"
!define MARIS_MACHINE_ENV "Software\MarisInstallerTest\Machine"
!define APP_ID "app.maris.test"
!include MUI2.nsh
Var installMode
!include "${INC}"
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English

!macro Probe LABEL
  ReadRegStr $0 HKCU "${MARIS_USER_ENV}" "Path"
  FileWrite $9 "${LABEL}=$0$\r$\n"
!macroend

Section
  StrCpy $installMode "CurrentUser"
  StrCpy $INSTDIR "C:\Program Files\Maris"
  FileOpen $9 "${RESULT}" w

  WriteRegExpandStr HKCU "${MARIS_USER_ENV}" "Path" "%USERPROFILE%\bin;C:\Tools"
  Call MarisAddToPath
  !insertmacro Probe "add"

  Call MarisAddToPath
  !insertmacro Probe "again"

  WriteRegExpandStr HKCU "${MARIS_USER_ENV}" "Path" "C:\A;C:\PROGRAM FILES\MARIS\BIN\;C:\B"
  Call MarisAddToPath
  !insertmacro Probe "present"

  WriteRegExpandStr HKCU "${MARIS_USER_ENV}" "Path" "C:\A;"
  Call MarisAddToPath
  !insertmacro Probe "trailing"

  DeleteRegValue HKCU "${MARIS_USER_ENV}" "Path"
  Call MarisAddToPath
  !insertmacro Probe "empty"

  ; A PATH near the length limit is left exactly as it is.
  StrCpy $1 "C:\Start"
  ${Do}
    StrCpy $1 "$1;C:\Some\Rather\Long\Folder\Name\For\Testing"
    StrLen $2 $1
  ${LoopUntil} $2 > 7950
  WriteRegExpandStr HKCU "${MARIS_USER_ENV}" "Path" $1
  Call MarisAddToPath
  ReadRegStr $0 HKCU "${MARIS_USER_ENV}" "Path"
  ${If} $0 == $1
    FileWrite $9 "long=unchanged$\r$\n"
  ${Else}
    FileWrite $9 "long=CHANGED$\r$\n"
  ${EndIf}

  FileClose $9
SectionEnd
