# RoomBoard

RoomBoard lee calendarios de Outlook/Microsoft 365 con la cuenta que ya autenticó el Hub y publica citas y estado de sala a los dispositivos autorizados de la red local.

- **Hub para Windows:** servicio Node.js que consulta Microsoft Graph, mantiene en caché los calendarios habilitados y los expone por REST y SSE.
- **Player para Windows y Android:** cliente Flutter. Cada dispositivo elige una sala de entre las que el Hub publica.
- **Solo lectura:** RoomBoard no crea, modifica ni traduce citas.

## Comportamiento

- El Hub lee todas las citas desde hoy hasta el final del día dentro de 14 días.
- Refresca cada 20 minutos de lunes a viernes entre las 07:00 y las 17:00, y cada 2 horas fuera de ese horario. La zona horaria se configura con `TIMEZONE`.
- El servidor puede limitar la lista de calendarios disponibles con `SYNC_CALENDAR_IDS`. Cada tablet elige su propia sala de esa lista; no hay un límite fijo de salas.
- El player muestra la fecha en inglés y alemán, la hora local, y el estado `FREE · FREI` o `OCCUPIED · BESETZT`. Si está ocupada, muestra el asunto original de Outlook. No muestra el organizador ni una agenda de próximas citas.
- Los tokens de Microsoft Graph permanecen en el Hub. Los dispositivos solo necesitan la URL del Hub y su clave `X-Device-Key`.

## Requisitos

- Windows 10/11 para el Hub y el instalador de escritorio.
- Node.js 20 o posterior para el Hub.
- Flutter 3.x para compilar los players.
- Para Windows: Visual Studio 2022 con el workload **Desktop development with C++** y CMake.
- Para Android: Android Studio, Android SDK y platform-tools.
- Inno Setup 6 para generar el instalador de Windows.

## Hub

```powershell
cd hub
Copy-Item .env.example .env
npm install
npm run dev
```

La primera ejecución en modo delegado muestra un código de inicio de sesión. Autentícate con la cuenta de Microsoft 365 que tiene acceso a los calendarios. El Hub conserva la caché MSAL cifrada localmente para las siguientes ejecuciones.

Variables principales de `hub/.env`:

| Variable | Uso |
|---|---|
| `AUTH_MODE` | `delegated` para usar la cuenta autenticada; `app` para buzones de sala con credenciales de aplicación. |
| `TENANT_ID`, `CLIENT_ID` | Identificadores de la aplicación de Entra ID. |
| `CLIENT_SECRET` | Obligatorio solo con `AUTH_MODE=app`. |
| `ROOM_MAILBOXES` | Buzones que se consultan en modo `app`, separados por comas. |
| `SYNC_CALENDAR_IDS` | IDs de los calendarios que el Hub permite sincronizar, separados por comas. Vacío publica todos los calendarios accesibles. |
| `TIMEZONE` | Zona horaria IANA usada para el horario de refresco y las consultas, por ejemplo `Europe/Zurich`. |
| `PORT` | Puerto HTTP del Hub (por defecto `8080`). |
| `DEVICE_KEYS` | Claves de dispositivos autorizados, separadas por comas. |
| `IGNORE_ALL_DAY` | Si es `true`, las citas de día completo no ponen la sala como ocupada. |

Para averiguar los IDs disponibles, deja `SYNC_CALENDAR_IDS` vacío, arranca el Hub y consulta `GET /api/calendars`. Copia los IDs elegidos en `.env` y reinicia el servicio. El Hub publicará solo esos calendarios y los tablets podrán escoger entre ellos.

Permisos de Microsoft Graph de solo lectura:

- Delegado: `Calendars.Read`, `Calendars.Read.Shared`, `offline_access` y `User.Read`.
- Aplicación: `Calendars.Read` con consentimiento de administrador y acceso limitado a los buzones necesarios según la política de la organización.

Producción del Hub: compila con `npm run build` y ejecuta `npm start`. Para instalarlo como servicio de Windows está disponible `hub/scripts/install-windows-service.bat`.

## Configurar un player

1. Abre RoomBoard en el tablet o PC.
2. Introduce la URL del Hub, por ejemplo `http://192.168.1.50:8080`, y la clave de dispositivo.
3. Pulsa **Probar conexión**, elige una sala publicada por el Hub y guarda.

La selección de sala queda guardada en el dispositivo. Para cambiarla, abre los ajustes desde el player.

## Compilar instalador Windows y APK Android

En Windows, instala las herramientas listadas en Requisitos. Desde PowerShell:

```powershell
cd app
./build-release.ps1
```

El script compila ambos destinos. Para compilar solo uno:

```powershell
./build-release.ps1 -Target windows
./build-release.ps1 -Target android
```

Salidas:

- Instalador Windows: `app/build/installer/RoomBoard-Setup-0.1.0-x64.exe`
- APK Android: `app/build/app/outputs/flutter-apk/app-release.apk`

La APK release usa la firma de depuración de Flutter, suficiente para instalarla directamente en los tablets de prueba. Para distribución gestionada o Play Store, configura una clave de firma de producción en Gradle.

## API del Hub

Todas las rutas requieren la cabecera `X-Device-Key`.

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/health` | Estado del Hub y número de calendarios en caché. |
| `GET` | `/api/calendars` | Calendarios permitidos para los players. |
| `GET` | `/api/calendars/:id/events?from=&to=` | Citas del calendario en ISO 8601. Por defecto devuelve la ventana de 14 días. |
| `GET` | `/api/rooms/:id/status` | Estado `free` o `busy` y cita actual. |
| `GET` | `/api/stream` | Actualizaciones SSE de cambios de estado y citas. |

## Red y seguridad

El player necesita conectividad con el Hub en la red local. Si se usa HTTP, Android permite tráfico en claro para las direcciones privadas configuradas en `app/android/app/src/main/res/xml/network_security_config.xml`. En producción se recomienda servir el Hub por HTTPS.

Los secretos y tokens de Microsoft permanecen en el Hub; las claves de dispositivo se validan en tiempo constante. El Hub solo expone calendarios permitidos por `SYNC_CALENDAR_IDS` y no ofrece operaciones de escritura sobre Outlook.
