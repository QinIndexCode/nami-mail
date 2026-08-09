; Nami Mail NSIS lifecycle policy.
; electron-builder loads this include for both the installer and its generated
; uninstaller. Keep data deletion deliberately scoped to Electron's default
; per-user userData directory: %APPDATA%\Nami Mail.

; Register the project-local NSIS plugin directory before any plugin call.
; electron-builder appends its own !addplugindir AFTER this include, but NSIS
; resolves plugin functions while the script is parsed, so the first use
; (customWelcomePage -> ${isUpdated} -> StdUtils::TestParameter below) would
; otherwise run before the plugin directory is on the search path.
!addplugindir /x86-unicode "${BUILD_RESOURCES_DIR}\x86-unicode"

!include "WordFunc.nsh"
!include "nsDialogs.nsh"

; electron-builder's generic --delete-app-data handler also considers the npm
; package-name directory. Nami Mail deliberately has one production userData
; directory, so retain only APP_FILENAME ("Nami Mail") as its deletion target.
!ifdef APP_PACKAGE_NAME
  !undef APP_PACKAGE_NAME
!endif
!ifdef APP_PRODUCT_FILENAME
  !undef APP_PRODUCT_FILENAME
!endif

; The external CLI always re-enters the installed Electron application. Do not
; create a second runtime, Node-only launcher, or a separate user-data path.
; The helper preserves the existing Path registry value kind and avoids the
; NSIS string-length limit while removing only this exact installation path.
;
; The installer path is passed explicitly via -CliPath (instead of relying on
; inherited process env) because nsExec::ExecToLog sometimes resets the child
; environment block when the installation directory path contains spaces or
; when Windows Defender temporarily hooks PowerShell creation. PATH registration
; is best-effort: a failure must never Abort the installation — it only means
; the user's shell will not automatically resolve `namimail.cmd` from PATH.
!macro namiApplyCliPath ACTION
  File /oname=$PLUGINSDIR\namimail-path.ps1 "${BUILD_RESOURCES_DIR}\namimail-path.ps1"
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\namimail-path.ps1" -Action "${ACTION}" -CliPath "$INSTDIR"`
  Pop $R0
!macroend

!macro namiRegisterCliPath
  !insertmacro namiApplyCliPath "register"
  ${If} $R0 != "0"
    DetailPrint "Nami Mail CLI PATH registration skipped (non-fatal, exit=$R0). To enable the namimail command manually, add $INSTDIR to your user Path."
  ${EndIf}
!macroend

!macro namiUnregisterCliPath
  !insertmacro namiApplyCliPath "unregister"
  ${If} $R0 != "0"
    DetailPrint "Nami Mail CLI PATH cleanup failed: $R0"
    SetErrorLevel 6
  ${EndIf}
!macroend

; Nami Mail stores one encrypted local profile per Windows user. Keep the
; assisted installer and directory picker, but skip the machine-wide choice so
; version checks and optional data removal always refer to that same user.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
Var /GLOBAL namiInstalledVersion
Var /GLOBAL namiVersionComparison

!macro namiReadInstalledVersion ROOT_KEY OUTPUT
  StrCpy ${OUTPUT} ""
  ReadRegStr ${OUTPUT} ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} ${OUTPUT} == ""
      ReadRegStr ${OUTPUT} ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" "DisplayVersion"
    ${EndIf}
  !endif
!macroend

!macro namiConsiderInstalledVersion CANDIDATE
  ${If} ${CANDIDATE} != ""
    ${If} $namiInstalledVersion == ""
      StrCpy $namiInstalledVersion ${CANDIDATE}
    ${Else}
      ${VersionCompare} "${CANDIDATE}" "$namiInstalledVersion" $namiVersionComparison
      ${If} $namiVersionComparison == "1"
        StrCpy $namiInstalledVersion ${CANDIDATE}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro namiFindCurrentUserInstalledVersion
  StrCpy $namiInstalledVersion ""
  !insertmacro namiReadInstalledVersion HKEY_CURRENT_USER $R0
  !insertmacro namiConsiderInstalledVersion $R0
!macroend

; initMultiUser runs before this hook. Reject machine-wide invocations and old
; machine-wide installs before the assisted page forces the current-user mode.
; Interactive installs explain the exact per-user version transition. Silent
; deployment stays idempotent, except for accidental downgrades.
!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Nami Mail 仅支持为当前 Windows 用户安装。请移除 /allusers 参数后重试。"
    ${EndIf}
    SetErrorLevel 4
    Quit
  ${EndIf}

  !insertmacro namiReadInstalledVersion HKEY_LOCAL_MACHINE $R2
  ${If} $R2 != ""
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "检测到旧的全用户 Nami Mail $R2。请先从 Windows 设置中卸载全用户版本，再重新运行此安装程序；现有邮箱数据不会被自动删除。"
    ${EndIf}
    SetErrorLevel 4
    Quit
  ${EndIf}

  !insertmacro namiFindCurrentUserInstalledVersion
  ${If} $namiInstalledVersion == ""
    Goto nami_install_version_done
  ${EndIf}

  ${VersionCompare} "$namiInstalledVersion" "${VERSION}" $namiVersionComparison
  ${If} $namiVersionComparison == "0"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Nami Mail ${VERSION} 已安装。$\r$\n$\r$\n选择“是”重新安装此版本；选择“否”关闭安装程序并继续使用现有版本。" IDYES nami_install_version_done
      SetErrorLevel 0
      Quit
    ${EndIf}
  ${ElseIf} $namiVersionComparison == "2"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "已安装 Nami Mail $namiInstalledVersion。$\r$\n$\r$\n安装程序将升级到 ${VERSION}，并保留本地数据。"
    ${EndIf}
  ${Else}
    ${GetParameters} $R0
    ${GetOptions} $R0 "--nami-allow-downgrade" $R1
    ${If} ${Errors}
      ${If} ${Silent}
        SetErrorLevel 3
        Quit
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "已安装较新的 Nami Mail $namiInstalledVersion。$\r$\n$\r$\n替换为旧版 ${VERSION} 可能移除新版程序文件，不建议继续。$\r$\n$\r$\n仍要降级吗？" IDYES nami_install_version_done
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}

  nami_install_version_done:
!macroend

!macro customInstall
  SetOutPath "$INSTDIR"
  File /oname=namimail.cmd "${BUILD_RESOURCES_DIR}\namimail.cmd"
  !insertmacro namiRegisterCliPath
!macroend

; Replaces electron-builder's default PowerShell-based app shutdown.
; Nami Mail hides to the system tray on window close (closeBehavior), so the
; default WM_CLOSE-only shutdown never exits the app and its surviving
; Electron renderer/GPU children make the default check report a still-running
; app. taskkill /T /F terminates the main process together with its whole
; process tree, so no orphan child process is left behind.
!macro customCheckAppRunning
  nami_check_app_loop:
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  ${If} $R0 != 0
    Goto nami_check_app_done
  ${EndIf}

  ${IfNot} ${isUpdated}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK nami_check_app_graceful
    Quit
  ${EndIf}

  nami_check_app_graceful:
  DetailPrint "$(appClosing)"

  ; Graceful close request (taskkill without /F posts WM_CLOSE).
  nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 3000

  ; Force close the whole process tree so no orphan child process remains.
  nsExec::Exec `"$CmdPath" /C taskkill /T /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 1500

  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY nami_check_app_loop
    Quit
  ${EndIf}

  nami_check_app_done:
!macroend

; --- Branded welcome and finish pages (assisted installer only) ---
; Defining these macros replaces the stock MUI pages. The welcome page shows a
; product summary next to the branded sidebar bitmap; the finish page mirrors
; the default run-after-finish behaviour with its own launch checkbox.
;
; The page functions live INSIDE the macros on purpose: the generated script
; includes this file before MUI2.nsh, and NSIS expands !insertmacro at parse
; time, so a top-level MUI_HEADER_TEXT call here would run before MUI2 defines
; it. Expanding together with the Page directive defers that to the point where
; electron-builder inserts the custom pages (after MUI2.nsh is loaded).
!macro customWelcomePage
  Page custom namiWelcomeCreate namiWelcomeLeave
  Var /GLOBAL namiWelcomeImage

  Function namiWelcomeCreate
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    InitPluginsDir
    File /oname=$PLUGINSDIR\installerSidebar.bmp "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
    !insertmacro MUI_HEADER_TEXT "欢迎使用 Nami Mail" "本地优先的多账户桌面邮件客户端"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateBitmap} 8u 0u 96u 184u ""
    Pop $namiWelcomeImage
    ${NSD_SetImage} $namiWelcomeImage "$PLUGINSDIR\installerSidebar.bmp" $0
    ${NSD_CreateLabel} 118u 30u 300u 26u "欢迎使用 Nami Mail ${VERSION}"
    Pop $0
    ${NSD_CreateLabel} 118u 64u 310u 130u "Nami Mail 是一款本地优先的桌面邮件客户端。$\r$\n$\r$\n您的邮件数据、账户凭据与加密密钥只保存在本机，应用直连您的邮箱服务商，不经过任何第三方服务器。$\r$\n$\r$\n点击“下一步”开始安装。"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function namiWelcomeLeave
  FunctionEnd
!macroend

!macro customFinishPage
  Page custom namiFinishCreate namiFinishLeave
  Var /GLOBAL namiFinishImage
  Var /GLOBAL namiLaunchCheckbox

  Function namiFinishCreate
    ${If} ${Silent}
      Abort
    ${EndIf}
    InitPluginsDir
    File /oname=$PLUGINSDIR\installerSidebar.bmp "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
    !insertmacro MUI_HEADER_TEXT "安装完成" "Nami Mail 已就绪"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateBitmap} 8u 0u 96u 184u ""
    Pop $namiFinishImage
    ${NSD_SetImage} $namiFinishImage "$PLUGINSDIR\installerSidebar.bmp" $0
    ${NSD_CreateLabel} 118u 30u 300u 26u "Nami Mail ${VERSION} 安装完成"
    Pop $0
    ${NSD_CreateLabel} 118u 64u 310u 90u "感谢您安装 Nami Mail。$\r$\n$\r$\n您的邮件数据始终保存在本机，可随时通过“设置”管理账户。"
    Pop $0
    ${NSD_CreateCheckBox} 118u 176u 300u 20u "立即运行 Nami Mail"
    Pop $namiLaunchCheckbox
    ${NSD_SetState} $namiLaunchCheckbox ${BST_CHECKED}
    nsDialogs::Show
  FunctionEnd

  Function namiFinishLeave
    ${NSD_GetState} $namiLaunchCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    ${EndIf}
  FunctionEnd
!macroend
!endif

!ifdef BUILD_UNINSTALLER
  Var /GLOBAL namiDeleteDataRequested

  !macro customUnInit
    StrCpy $namiDeleteDataRequested "0"
    ${GetParameters} $R0
    ${GetOptions} $R0 "--nami-delete-data" $R1
    ${IfNot} ${Errors}
      StrCpy $namiDeleteDataRequested "1"
    ${EndIf}
  !macroend

  !macro namiDeleteCurrentUserData
    Push $R0
    SetShellVarContext current
    StrCpy $R0 "$APPDATA\${PRODUCT_FILENAME}"
    DetailPrint "正在删除 $R0 中的 Nami Mail 数据"
    ClearErrors
    RMDir /r "$R0"
    IfFileExists "$R0\*.*" 0 +2
      SetErrors
    ${If} ${Errors}
      DetailPrint "无法完整删除 Nami Mail 数据：$R0"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "部分 Nami Mail 本地数据未能删除。请关闭仍在使用这些文件的程序，然后手动检查：$\r$\n$\r$\n$R0"
      ${EndIf}
      SetErrorLevel 5
    ${EndIf}
    Pop $R0
  !macroend

  ; During an in-place update electron-builder invokes the old uninstaller
  ; with --updated. Never show a prompt or remove user data on that path.
  !macro customUnInstall
    !insertmacro namiUnregisterCliPath

    ${If} ${isUpdated}
      Goto nami_uninstall_data_done
    ${EndIf}

    ${If} $namiDeleteDataRequested == "1"
      !insertmacro namiDeleteCurrentUserData
      Goto nami_uninstall_data_done
    ${EndIf}

    ${If} ${Silent}
      Goto nami_uninstall_data_done
    ${EndIf}

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时永久删除当前 Windows 用户的 Nami Mail 本地数据？$\r$\n$\r$\n这只会删除 $APPDATA\${PRODUCT_FILENAME}，其中包括本地数据库、账户凭据、设置和加密密钥；不会删除邮箱服务商上的邮件。$\r$\n$\r$\n选择“否”可保留数据（推荐）。" IDYES nami_uninstall_delete_data
    Goto nami_uninstall_data_done

    nami_uninstall_delete_data:
      !insertmacro namiDeleteCurrentUserData
    nami_uninstall_data_done:
  !macroend
!endif
