# RoomBoard

Visor de citas y estado de sala (libre / ocupada) basado en calendarios de **Outlook / Microsoft 365**.

- **Hub** (Windows): servicio Node.js + TypeScript que habla con Microsoft Graph y expone una API local.
- **App Windows**: cliente Flutter de escritorio para ver y configurar los calendarios.
- **APK Android**: el mismo cliente Flutter, compilado para tablets en modo kiosco (pantalla de sala con código de color y reservas rápidas).

## Arquitectura

```
Outlook / Exchange Online
        │  Microsoft Graph (OAuth 2.0)
        ▼
   HUB (Windows, Node.js + TypeScript)
   caché + lógica libre/ocupada + SSE
        │  REST + SSE (red local, clave de dispositivo X-Device-Key)
   ┌────┴─────────────┐
   ▼                  ▼
App Windows        APK Android (tablet)
(Flutter)          (Flutter, modo kiosco)
```

Los clientes **nunca** hablan con Microsoft Graph ni guardan tokens de Outlook. Todo pasa exclusivamente por el Hub local.

## Funcionalidades

- Listar los calendarios de Outlook disponibles y elegir cuáles mostrar.
- Vista de agenda en escritorio: citas de hoy y de los próximos 7 días agrupadas por día, con hora, asunto, organizador, lugar e indicador "Ahora".
- Estado de sala en tiempo real: libre (verde) u ocupada (rojo), reunión actual, siguiente reunión y cuenta atrás.
- Actualización automática e inmediata mediante Server-Sent Events (SSE) y refresco periódico configurable (`POLL_SECONDS`).
- Pantalla de tablet a pantalla completa en modo kiosco (orientación horizontal fija, wakelock para mantener la pantalla encendida y barras del sistema ocultas).
- **Reservas rápidas**: reserva de 15, 30 o 60 minutos directamente desde la pantalla de sala cuando está libre, con verificación estricta de solapamiento (409).
- Modos de tema claro, oscuro y automático en la app de escritorio.

## Requisitos

- Windows 10/11
- Node.js 20 LTS o superior
- Flutter 3.x (con soporte Windows desktop y Android)
- Android Studio (SDK y platform-tools) para compilar la APK
- Cuenta de Microsoft 365 con acceso a los calendarios (y permisos de administrador si se usan buzones de sala con permisos de aplicación)

---

## 1. Registrar la aplicación en Microsoft Entra ID

1. Entra en https://entra.microsoft.com → **Identidad → Aplicaciones → Registros de aplicaciones → Nuevo registro**.
2. Nombre: `RoomBoard`. Tipo de cuenta: *Solo las cuentas de este directorio organizativo*.
3. En **Autenticación**:
   - Activa **Permitir flujos de cliente público** = **Sí** (necesario para el flujo de código de dispositivo en modo delegado).
4. En **Permisos de API → Microsoft Graph**:
   - **Modo delegado** (`AUTH_MODE=delegated`, para tus propios calendarios):
     - `Calendars.Read`
     - `Calendars.Read.Shared`
     - `offline_access`
     - `User.Read`
   - **Modo aplicación** (`AUTH_MODE=app`, para buzones de sala compartidos sin usuario interactivo):
     - `Calendars.Read` (solo lectura de citas y estado)
     - `Calendars.ReadWrite` (obligatorio si se utiliza la funcionalidad de **reservas rápidas**)
     - Concede el **Consentimiento de administrador** para tu organización.
5. En modo aplicación, genera un **Secreto de cliente** en *Certificados y secretos* y restringe el acceso a buzones con una *Application Access Policy* en Exchange Online PowerShell si lo exige tu organización.
6. Anota: `Tenant ID`, `Client ID` y `Client Secret`.

---

## 2. Configurar y arrancar el Hub

```bash
cd hub
cp .env.example .env
npm install
```

### Variables de `.env`:

| Variable | Descripción | Ejemplo |
|---|---|---|
| `AUTH_MODE` | `delegated` (mis calendarios) o `app` (buzones de sala) | `delegated` |
| `TENANT_ID` | ID del tenant de Entra ID | `xxxxxxxx-...` |
| `CLIENT_ID` | ID de la aplicación registrada | `xxxxxxxx-...` |
| `CLIENT_SECRET` | Secreto de cliente (obligatorio en modo `app`) | `xyz~...` |
| `ROOM_MAILBOXES` | Lista separada por comas de buzones de sala (modo `app`) | `sala1@empresa.com,sala2@empresa.com` |
| `TIMEZONE` | Zona horaria IANA para citas y calendarios | `Europe/Madrid` |
| `PORT` | Puerto HTTP donde escucha el Hub | `8080` |
| `DEVICE_KEYS` | Claves autorizadas de dispositivos (`X-Device-Key`) | `clave-tablet-1,clave-pc` |
| `POLL_SECONDS` | Intervalo de sondeo periódico de respaldo en segundos | `45` |
| `IGNORE_ALL_DAY` | Ignorar eventos de día completo en estado libre/ocupada (`true`/`false`) | `true` |

### Arranque en desarrollo:

```bash
npm run dev
```

En modo `delegated`, la primera vez el Hub muestra en consola un código y una URL (`https://microsoft.com/devicelogin`). Inicia sesión con la cuenta de Microsoft 365; el token se guarda cifrado en disco local (`~/.roomboard/msal-token-cache.enc`) con AES-256-GCM y se renueva automáticamente.

### Ejecutar como servicio de Windows (Producción)

Compila primero el Hub:
```bash
npm run build
```

#### Opción A: Servicio con NSSM y rotación de logs (Recomendado)

Se incluye el script automatizado en `hub/scripts/install-windows-service.bat`. Ejecútalo como Administrador:
```cmd
cd hub
scripts\install-windows-service.bat
```
El script configura:
- Arranque automático con Windows (`SERVICE_AUTO_START`).
- Reinicio automático ante fallos tras 5 segundos.
- Rotación de logs en `hub/logs/` al alcanzar 10 MB (`AppRotateBytes 10485760`).

Para detener o desinstalar:
```cmd
nssm stop RoomBoardHub
nssm remove RoomBoardHub confirm
```

#### Opción B: PM2 con rotación de logs

```bash
npm install -g pm2 pm2-windows-startup
cd hub
pm2 start ecosystem.config.cjs
pm2-startup install
pm2 save
```
La configuración de `ecosystem.config.cjs` rota los ficheros `hub-out.log` y `hub-error.log` al superar 10 MB, reteniendo los últimos 7 ficheros comprimidos.

---

## 3. App Windows (Flutter)

```bash
cd app
flutter pub get
flutter run -d windows
```

Al abrirla por primera vez:
1. Introduce la URL del Hub (por ejemplo `http://192.168.1.50:8080`) y la clave de dispositivo `X-Device-Key`.
2. Pulsa **Probar conexión** para verificar la comunicación con `/api/health`.
3. Elige la sala o calendario predeterminado en el desplegable y pulsa **Guardar configuración**. Las credenciales se almacenan cifradas en Windows Credential Manager / Secure Storage.

### Compilación para distribución en Windows:

```bash
cd app
flutter build windows --release
# Resultado: app/build/windows/x64/runner/Release/
```

---

## 4. APK Android (Tablet en modo kiosco)

Configuración de la aplicación Android:
- **Application ID**: `com.roomboard.app`
- **Nombre**: `RoomBoard`
- **Permisos mínimos**: `INTERNET`, `ACCESS_NETWORK_STATE` y `WAKE_LOCK`.

### Compilación de la APK de producción:

```bash
cd app
flutter build apk --release
# Resultado: app/build/app/outputs/flutter-apk/app-release.apk
```

Instalación en el tablet por USB con ADB:
```bash
adb install app/build/app/outputs/flutter-apk/app-release.apk
```

### Configuración en el tablet:
1. **Red local (HTTP en claro)**: el fichero `app/android/app/src/main/res/xml/network_security_config.xml` permite tráfico HTTP hacia la IP del Hub en red local.
   > **Nota de seguridad:** En entornos empresariales de producción se recomienda encarecidamente utilizar HTTPS (mediante un proxy inverso como Caddy, Nginx o IIS con certificado interno) y desactivar `cleartextTrafficPermitted`.
2. **Modo kiosco**: activa la opción *Fijar pantalla* de Android (Ajustes → Seguridad → Fijar aplicaciones) o utiliza una app como *Fully Kiosk Browser* o modo *Device Owner*.
3. **Pantalla encendida**: la aplicación utiliza `wakelock_plus` para evitar que la pantalla del tablet se apague mientras esté activa.

---

## API del Hub

Todas las peticiones a la API del Hub requieren la cabecera `X-Device-Key`. Las claves se validan en tiempo constante.

| Método | Ruta | Descripción | Códigos HTTP |
|---|---|---|---|
| `GET` | `/api/health` | Estado del Hub, zona horaria y calendarios en caché | 200, 401, 429 |
| `GET` | `/api/calendars` | Calendarios disponibles | 200, 401, 502 |
| `GET` | `/api/calendars/:id/events?from=&to=` | Citas de un calendario en formato ISO 8601 | 200, 400, 401, 502 |
| `GET` | `/api/rooms/:id/status` | Estado actual: `{ state: "free" \| "busy", current, next, until }` | 200, 400, 401, 502 |
| `GET` | `/api/stream` | Canal Server-Sent Events (SSE) con eventos `status`, `events` y heartbeat cada 20 s | 200, 401 |
| `POST` | `/api/rooms/:id/book` | Crea una reserva rápida: `{ minutes: 15 \| 30 \| 60, subject? }` | 201, 400, 401, 409, 502 |

### Ejemplo de reserva rápida:

Petición:
```http
POST /api/rooms/sala1@empresa.com/book HTTP/1.1
Host: 192.168.1.50:8080
X-Device-Key: clave-tablet-1
Content-Type: application/json

{
  "minutes": 30,
  "subject": "Reunión rápida espontánea"
}
```

Respuesta exitosa (`201 Created`):
```json
{
  "status": "booked",
  "roomId": "sala1@empresa.com",
  "event": {
    "id": "AAMkAG...",
    "subject": "Reunión rápida espontánea",
    "start": "2026-10-30T10:00:00.000Z",
    "end": "2026-10-30T10:30:00.000Z",
    "showAs": "busy"
  },
  "roomStatus": {
    "state": "busy",
    "until": "2026-10-30T10:30:00.000Z"
  }
}
```

Si la sala tiene una reunión que se solapa con el intervalo solicitado, el Hub devuelve `409 Conflict`:
```json
{
  "error": "Conflict",
  "message": "La sala no está libre para el intervalo seleccionado; ya existe una reunión solapada."
}
```

---

## Solución de problemas

### 1. Flujo de código de dispositivo caducado (Modo `delegated`)
- **Síntoma:** El Hub muestra el código `https://microsoft.com/devicelogin`, pero tras 15 minutos sin introducirlo en el navegador, la autenticación expira.
- **Solución:** Reinicia el servicio (`npm run dev` o `nssm restart RoomBoardHub`). Se generará un nuevo código y una nueva URL de inicio de sesión. Una vez completado el inicio de sesión una sola vez, la caché cifrada en disco mantendrá el token renovado indefinidamente sin volver a solicitar código.

### 2. Errores HTTP 401 o 403 de Microsoft Graph
- **HTTP 401 Unauthorized:** Comprueba que el `TENANT_ID` y `CLIENT_ID` sean correctos y que en modo `app` el `CLIENT_SECRET` no haya caducado. Si el Hub recibe un 401 de Graph, intentará automáticamente renovar el token una vez con `forceRefresh: true`.
- **HTTP 403 Forbidden:**
  - En modo `delegated`: revisa que la aplicación tenga concedido el permiso delegado `Calendars.Read`.
  - En modo `app`: verifica que se haya pulsado **Conceder consentimiento de administrador** en Entra ID para `Calendars.Read` (o `Calendars.ReadWrite` si se usan reservas rápidas).
  - En buzones de sala: comprueba que las direcciones en `ROOM_MAILBOXES` existan y no estén bloqueadas por directivas de acceso de Exchange.

### 3. Tablet sin conexión con el Hub
- **Síntoma:** La pantalla de sala muestra el aviso amarillo discreto *"Sin conexión con el Hub · Reintentando..."*.
- **Comprobaciones:**
  1. Verifica que el tablet y el PC/servidor del Hub estén conectados a la **misma red Wi-Fi o subred LAN**.
  2. Comprueba la IP del Hub haciendo `ipconfig` en Windows e introduce la URL completa con puerto (ej. `http://192.168.1.50:8080`).
  3. Comprueba que el tablet tenga permisos de red y que `network_security_config.xml` esté activo si se conecta vía HTTP sin certificado SSL.
  4. Desde el navegador del tablet, abre `http://<IP-DEL-HUB>:8080/api/health` para comprobar si responde el servidor web.

### 4. Reglas del Firewall de Windows
- **Síntoma:** El Hub funciona localmente en `http://localhost:8080`, pero los tablets de la red local no consiguen conectar (tiempo de espera agotado).
- **Solución:** Abre el puerto 8080 en el Firewall de Windows para el perfil de red privada ejecutando en PowerShell como Administrador:
  ```powershell
  New-NetFirewallRule -DisplayName "RoomBoard Hub" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private
  ```
  O con la utilidad de línea de comandos `netsh`:
  ```cmd
  netsh advfirewall firewall add rule name="RoomBoard Hub" dir=in action=allow protocol=TCP localport=8080 profile=private
  ```

---

## Seguridad

- **Tokens y secretos aislados**: Viven exclusivamente en el Hub (`.env` fuera de control de versiones). Los clientes Flutter no conocen las credenciales de Microsoft Graph.
- **Caché cifrada local**: Los tokens de MSAL se almacenan con cifrado AES-256-GCM y clave derivada en `~/.roomboard/msal-token-cache.enc` con permisos `0600`.
- **Autenticación en tiempo constante**: La cabecera `X-Device-Key` se compara en tiempo constante mediante hashes SHA-256 (`crypto.timingSafeEqual`) para prevenir ataques de temporización.
- **CORS restringido**: El Hub bloquea cualquier origen que no pertenezca a la red privada local o localhost con HTTP 403.
- **Privilegios mínimos**: Solo lectura (`Calendars.Read`) salvo que se habiliten reservas rápidas (`Calendars.ReadWrite`).
