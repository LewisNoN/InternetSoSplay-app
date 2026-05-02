; installer.nsh — Script NSIS personalizado para InternetSOSplay
; Se ejecuta durante instalacion y desinstalacion

!macro customUnInstall
  ; Preguntar si quiere borrar datos de configuracion
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "¿Deseas eliminar también tu configuración y datos guardados de InternetSOSplay?$\n$\n(Licencia, parámetros de red, preferencias)" \
    IDNO skip_appdata

  ; Borrar carpeta userData de Electron (AppData\Roaming\internetsosplay)
  RMDir /r "$APPDATA\internetsosplay"
  ; Por si acaso también la variante con nombre del producto
  RMDir /r "$APPDATA\InternetSOSplay"

  skip_appdata:
!macroend

!macro customInstall
  ; Nada extra en instalacion por ahora
!macroend
