; Nami Mail NSIS lifecycle policy.
; electron-builder loads this include for both the installer and its generated
; uninstaller. Keep data deletion deliberately scoped to Electron's default
; per-user userData directory: %APPDATA%\Nami Mail.

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
