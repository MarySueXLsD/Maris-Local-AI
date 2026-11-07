; Shows the installer's copying page (resources/installer.nsh) for a few seconds without installing
; anything, and writes where the Back, Next and Cancel buttons are. Built and run by
; tests/installer/check-ui.cjs, which also takes a screenshot of the page.
Unicode true
Name "Maris installer UI test"
OutFile "${OUT}"
RequestExecutionLevel user
AutoCloseWindow true

!define APP_ID "app.maris.test"
; About the size of the real app, for the "about N MB" line.
!define APP_64_UNPACKED_SIZE 412000
!include MUI2.nsh
Var installMode
!include "${INC}"

Function .onInit
  ; Straight to the copying page, with the default Extras.
  StrCpy $MarisSkipPage 1
  StrCpy $MarisDesktop 1
  StrCpy $MarisPath 1
  StrCpy $MarisFolderMenu 1
  StrCpy $MarisStartup 0
  StrCpy $installMode "CurrentUser"
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Maris"
FunctionEnd

!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English

!macro Rect ID LABEL
  GetDlgItem $1 $HWNDPARENT ${ID}
  System::Call '*(i,i,i,i)p.r2'
  System::Call 'user32::GetWindowRect(p r1, p r2)'
  System::Call '*$2(i.r3,i.r4,i.r5,i.r6)'
  System::Free $2
  FileWrite $9 "${LABEL}=$3,$4,$5,$6$\r$\n"
!macroend

Section
  FileOpen $9 "${RESULT}" w
  !insertmacro Rect 3 "back"
  !insertmacro Rect 1 "next"
  !insertmacro Rect 2 "cancel"
  ${If} $MarisPlan != ""
    FileWrite $9 "plan=yes$\r$\n"
  ${EndIf}
  FileClose $9
  ; The runner takes its screenshot now.
  Sleep 5000
SectionEnd
