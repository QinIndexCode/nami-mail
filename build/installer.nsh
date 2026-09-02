; Nami Mail NSIS lifecycle policy.
; electron-builder loads this include for both the installer and its generated
; uninstaller. Keep data deletion deliberately scoped to Electron's default
; per-user userData directory: %APPDATA%\Nami Mail.
;
; The installer UI is the stock assisted (MUI2) flow: the MUI welcome page
; (branded sidebar via MUI_WELCOMEFINISHPAGE_BITMAP = build/installerSidebar.bmp,
; a 164x314 BMP that matches MUI2's own layout), the MUI license and directory
; pages, instfiles, and the stock MUI finish page with its run checkbox.
; No custom page geometry and no WebView2 / HTML layer are involved — native
; pages keep startup instant and scale proportionally at every DPI setting.

!include "WordFunc.nsh"

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
; StrContains.nsh defines an install-time function; including it in the
; uninstaller build leaves it unreferenced, which -WX (warnings as errors)
; rejects. Its only consumer (namiNormalizeInstDir) is installer-only.
!include "StrContains.nsh"
Var /GLOBAL namiInstalledVersion
Var /GLOBAL namiVersionComparison

; Keep the app-name suffix behaviour of electron-builder's stock instfiles pre
; hook: when the user picks a bare folder, append the product folder name to it.
!macro namiNormalizeInstDir
  ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
  ${If} $0 == ""
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend

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

; Returns in $R0 "" when the directory stored in $INSTDIR is NOT reachable, or
; "1" when it is (either it exists now or one of its ancestors does). initMultiUser
; reuses a leftover registry InstallLocation as INSTDIR; if that path lives on a
; drive/partition that no longer exists (e.g. the user manually deleted the app
; folder and then repartitioned the data drive), the SetOutPath/File writes below
; would fail and block the whole install with raw write errors. Probed here so
; customInit can fall back to a reachable default directory before any page shows.
!macro namiCheckInstDirReachable
  Push $R1
  Push $R2
  StrCpy $R0 "$INSTDIR"
  nami_reach_up:
    StrLen $R2 $R0
    ${If} $R2 <= 3
      Goto nami_reach_probe
    ${EndIf}
    IfFileExists "$R0\*.*" nami_reach_ok
    ${StdUtils.GetParentPath} $R1 $R0
    StrCpy $R0 $R1
    Goto nami_reach_up
  nami_reach_probe:
    IfFileExists "$R0\*.*" nami_reach_ok
    StrCpy $R0 ""
    Goto nami_reach_done
  nami_reach_ok:
    StrCpy $R0 "1"
  nami_reach_done:
  Pop $R2
  Pop $R1
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

  ; initMultiUser has already copied the leftover registry InstallLocation into
  ; INSTDIR. If that path is now unreachable (deleted + drive repartitioned), the
  ; writes below would fail and block the install with raw errors. Fall back to
  ; the per-user default directory instead; InstallLocation is later refreshed to
  ; the new path on a successful install, so the stale entry stops mattering.
  !insertmacro namiCheckInstDirReachable
  ${If} $R0 == ""
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "检测到上次安装目录不再可达（所在磁盘分区可能已变更或已被删除）。$\r$\n$\r$\n安装程序将改用到默认目录：$\r$\n$LocalAppData\Programs\${APP_FILENAME}"
    ${EndIf}
    StrCpy $INSTDIR "$LocalAppData\Programs\${APP_FILENAME}"
  ${EndIf}

  !insertmacro namiFindCurrentUserInstalledVersion
  ${If} $namiInstalledVersion == ""
    Goto nami_install_version_done
  ${EndIf}

  ${VersionCompare} "$namiInstalledVersion" "${VERSION}" $namiVersionComparison
  ${If} $namiVersionComparison == "0"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Nami Mail ${VERSION} 已安装。$\r$\n$\r$\n选择$\"是$\"重新安装此版本；选择$\"否$\"关闭安装程序并继续使用现有版本。" IDYES nami_install_version_done
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
  ; Poll for a clean self-exit (up to 5s, 250ms steps) instead of a fixed
  ; Sleep: an app that exits quickly no longer pays the full wait.
  StrCpy $R1 0
  nami_wait_close:
    Sleep 250
    nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${If} $R0 != 0
      Goto nami_check_app_done
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 < 20
      Goto nami_wait_close
    ${EndIf}

  ; Force close the whole process tree so no orphan child process remains.
  nsExec::Exec `"$CmdPath" /C taskkill /T /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 500

  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY nami_check_app_loop
    Quit
  ${EndIf}

  nami_check_app_done:
!macroend

; --- Pages (assisted installer only) ---
; customWelcomePage feeds the stock MUI2 pages: electron-builder already sets
; MUI_WELCOMEFINISHPAGE_BITMAP to build/installerSidebar.bmp (164x314), so the
; welcome page shows the branded sidebar at MUI2's own coordinates with zero
; custom geometry. customFinishPage is deliberately NOT defined: the stock
; template then inserts the MUI finish page with its run-after-install
; checkbox and the StdUtils launch function. The MUI_* defines must appear
; before the respective !insertmacro MUI_PAGE_* to take effect.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 Nami Mail 安装向导"
  !define MUI_WELCOMEPAGE_TEXT "Nami Mail 是一款本地优先的多账户桌面邮件客户端。$\r$\n$\r$\n您的邮件数据、账户凭据与加密密钥只保存在本机，应用直连您的邮箱服务商，不经过任何第三方服务器。$\r$\n$\r$\n点击$\"下一步$\"继续。"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE namiWelcomePre
  !insertmacro MUI_PAGE_WELCOME
  ; The MUI license and directory pages are the primary flow. Both are skipped
  ; for silent installs and in-place updates (--updated keeps the previous
  ; directory choice and reuses it directly).
  !define MUI_PAGE_CUSTOMFUNCTION_PRE namiLicensePre
  !insertmacro MUI_PAGE_LICENSE "${BUILD_RESOURCES_DIR}\..\LICENSE"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE namiDirectoryPre
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE namiDirectoryLeave
  !insertmacro MUI_PAGE_DIRECTORY

  Function namiWelcomePre
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  Function namiLicensePre
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  Function namiDirectoryPre
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  Function namiDirectoryLeave
    !insertmacro namiNormalizeInstDir
    ; The user picked this folder from the directory page. Reuse the same
    ; reachability probe as customInit: if the selected path lives on a
    ; drive/partition that no longer exists, setout/write would fail with a raw
    ; error and block the whole install. Reject it here so the user can pick a
    ; reachable directory before any file is written.
    !insertmacro namiCheckInstDirReachable
    ${If} $R0 == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "所选目录不可达（所在磁盘分区可能已变更或已被删除）。$\r$\n$\r$\n请选择其它可用的目录以继续安装。"
      Abort
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

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时永久删除当前 Windows 用户的 Nami Mail 本地数据？$\r$\n$\r$\n这只会删除 $APPDATA\${PRODUCT_FILENAME}，其中包括本地数据库、账户凭据、设置和加密密钥；不会删除邮箱服务商上的邮件。$\r$\n$\r$\n选择$\"否$\"可保留数据（推荐）。" IDYES nami_uninstall_delete_data
    Goto nami_uninstall_data_done

    nami_uninstall_delete_data:
      !insertmacro namiDeleteCurrentUserData
    nami_uninstall_data_done:
  !macroend
!endif
