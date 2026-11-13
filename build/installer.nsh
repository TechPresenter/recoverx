; RecoverX — NSIS customisations, included by electron-builder through
; `nsis.include` in electron-builder.yml.
;
; One customisation: on an interactive uninstall, offer to remove the user's
; RecoverX data as well (Microsoft Store Policy 10.2.7 asks that an uninstall
; leave nothing behind that the user did not choose to keep).
;
; Why this is opt-in, defaulting to No:
;   %APPDATA%\RecoverX holds settings, recovery history and the licence
;   activation. Most uninstalls are a reinstall or an upgrade in disguise, and
;   silently destroying the activation there would cost a paying customer a
;   support ticket. electron-builder's own `deleteAppDataOnUninstall` cannot
;   express "ask": when true it deletes the data on every uninstall that is not
;   an update — assisted installers too, and silent (/S) uninstalls included
;   (app-builder-lib 26.15.3, templates/nsis/uninstaller.nsh). It must stay
;   false in electron-builder.yml while this macro provides the prompt.
;
; Why it never runs unattended:
;   - ${Silent}: the Microsoft Store, deployment tools and our own update flow
;     all uninstall with /S. Nobody is there to answer, and the default must be
;     the safe one, so a silent uninstall keeps the data (and the MessageBox
;     also carries /SD IDNO in case silence is ever detected differently).
;   - ${isUpdated}: an update runs the PREVIOUS version's uninstaller with
;     --updated before installing the new files. Offering to delete the
;     user's data in the middle of an update would be absurd.
;
; Recovered files are never touched: they live wherever the user saved them
; (by default Documents\RecoverX Recovered), not under %APPDATA%.
;
; Known limitation, shared with electron-builder's built-in option: the
; uninstaller elevates through UAC (perMachine install), and %APPDATA% is
; resolved for the account that approved the prompt. For the usual case — an
; administrator in Admin Approval Mode — that is the same user. When a standard
; user types an administrator's credentials, it is the administrator's profile,
; where no RecoverX data exists, and nothing is removed.
;
; Macro and variable names are those of app-builder-lib 26.15.3
; (templates/nsis/uninstaller.nsh): `customUnInstall` is inserted at the start
; of the uninstall section, before the program files are removed; $installMode
; is "all" for a per-machine install.

!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove your RecoverX settings, recovery history and licence activation from this computer?$\r$\n$\r$\nChoose No if you might reinstall. Files you have recovered are not affected either way, and your licence key keeps working: you can activate it again on this computer at any time." /SD IDNO IDYES`
      ; Electron keeps user data per user, under the product name — the
      ; directory app.getPath('userData') resolves to (APP_DATA_FOLDER in
      ; src/shared/constants/app.ts). A per-machine install runs the
      ; uninstaller in the all-users context, so switch to the current user to
      ; resolve $APPDATA, and switch back for the registry clean-up that
      ; follows this macro.
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}

      DetailPrint "Removing $APPDATA\${PRODUCT_FILENAME}"
      RMDir /r "$APPDATA\${PRODUCT_FILENAME}"

      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
