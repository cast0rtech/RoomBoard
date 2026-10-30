import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'api_client.dart';
import 'models.dart';
import 'sse_client.dart';
import 'storage.dart';

/// Proveedor del modo de tema (Claro / Oscuro / Sistema).
final themeModeProvider = StateProvider<ThemeMode>((ref) => ThemeMode.system);

/// Proveedor del almacenamiento seguro multiplataforma (Windows y Android).
final secureSettingsStorageProvider = Provider<SecureSettingsStorage>((ref) {
  return SecureSettingsStorage();
});

/// Notifier asíncrono que gestiona la configuración de conexión guardada en disco seguro.
class ConnectionSettingsNotifier extends AsyncNotifier<ConnectionSettings> {
  @override
  Future<ConnectionSettings> build() async {
    final storage = ref.watch(secureSettingsStorageProvider);
    return storage.loadSettings();
  }

  Future<void> save(ConnectionSettings newSettings) async {
    final storage = ref.read(secureSettingsStorageProvider);
    state = const AsyncValue.loading();
    await storage.saveSettings(newSettings);
    state = AsyncValue.data(newSettings);
  }

  Future<void> selectCalendar(CalendarInfo calendar) async {
    final current = state.valueOrNull ?? const ConnectionSettings();
    final updated = current.copyWith(
      selectedCalendarId: calendar.id,
      selectedCalendarName: calendar.name,
    );
    await save(updated);
  }

  Future<void> clear() async {
    final storage = ref.read(secureSettingsStorageProvider);
    await storage.clearSettings();
    state = const AsyncValue.data(ConnectionSettings());
  }
}

final connectionSettingsProvider =
    AsyncNotifierProvider<ConnectionSettingsNotifier, ConnectionSettings>(
  ConnectionSettingsNotifier.new,
);

/// Proveedor de `ApiClient` configurado con la URL del Hub y la clave `X-Device-Key` activas.
final apiClientProvider = Provider<ApiClient?>((ref) {
  final settingsAsync = ref.watch(connectionSettingsProvider);
  final settings = settingsAsync.valueOrNull;
  if (settings == null || !settings.hasCredentials) {
    return null;
  }
  return ApiClient(
    hubUrl: settings.hubUrl,
    deviceKey: settings.deviceKey,
  );
});

/// Proveedor del cliente SSE conectado al Hub local.
final sseClientProvider = Provider<SseClient?>((ref) {
  final settings = ref.watch(connectionSettingsProvider).valueOrNull;
  if (settings == null || !settings.hasCredentials) {
    return null;
  }

  final client = SseClient(
    hubUrl: settings.hubUrl,
    deviceKey: settings.deviceKey,
  )..connect();

  ref.onDispose(client.dispose);
  return client;
});

/// Estado de conexión en vivo del stream SSE (`true` = conectado).
final sseConnectedProvider = StreamProvider<bool>((ref) {
  final sseClient = ref.watch(sseClientProvider);
  if (sseClient == null) {
    return Stream<bool>.value(false);
  }
  return sseClient.connectionChanges;
});

/// Stream de mensajes SSE en tiempo real desde el Hub.
final sseMessagesProvider = StreamProvider<SseMessage>((ref) {
  final sseClient = ref.watch(sseClientProvider);
  if (sseClient == null) {
    return const Stream<SseMessage>.empty();
  }
  return sseClient.messages;
});

/// Lista de calendarios disponibles en el Hub (`GET /api/calendars`).
final calendarsProvider = FutureProvider<List<CalendarInfo>>((ref) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) {
    return const <CalendarInfo>[];
  }
  return api.listCalendars();
});

/// Estado en tiempo real de la sala seleccionada (combina carga inicial REST + actualizaciones SSE).
final roomStatusProvider = StreamProvider.family<RoomStatus, String>((ref, roomId) async* {
  final api = ref.watch(apiClientProvider);
  if (api == null || roomId.trim().isEmpty) {
    yield const RoomStatus(state: RoomState.free);
    return;
  }

  yield await api.getRoomStatus(roomId);

  final sseClient = ref.watch(sseClientProvider);
  if (sseClient == null) {
    return;
  }

  await for (final msg in sseClient.messages) {
    if (msg.type == SseEventType.status &&
        (msg.calendarId == null || msg.calendarId == roomId) &&
        msg.status != null) {
      yield msg.status!;
    }
  }
});

/// Citas del calendario seleccionado (combina carga inicial REST + actualizaciones SSE).
final calendarEventsProvider = StreamProvider.family<List<Event>, String>((ref, calendarId) async* {
  final api = ref.watch(apiClientProvider);
  if (api == null || calendarId.trim().isEmpty) {
    yield const <Event>[];
    return;
  }

  yield await api.listEvents(calendarId);

  final sseClient = ref.watch(sseClientProvider);
  if (sseClient == null) {
    return;
  }

  await for (final msg in sseClient.messages) {
    if (msg.type == SseEventType.events &&
        (msg.calendarId == null || msg.calendarId == calendarId) &&
        msg.events != null) {
      yield msg.events!;
    }
  }
});
