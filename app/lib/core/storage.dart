import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Configuración de conexión del cliente Flutter con el Hub local.
class ConnectionSettings {
  const ConnectionSettings({
    this.hubUrl = '',
    this.deviceKey = '',
    this.selectedCalendarId,
    this.selectedCalendarName,
  });

  final String hubUrl;
  final String deviceKey;
  final String? selectedCalendarId;
  final String? selectedCalendarName;

  bool get isConfigured =>
      hubUrl.trim().isNotEmpty &&
      deviceKey.trim().isNotEmpty &&
      (selectedCalendarId != null && selectedCalendarId!.trim().isNotEmpty);

  bool get hasCredentials => hubUrl.trim().isNotEmpty && deviceKey.trim().isNotEmpty;

  ConnectionSettings copyWith({
    String? hubUrl,
    String? deviceKey,
    String? selectedCalendarId,
    String? selectedCalendarName,
  }) {
    return ConnectionSettings(
      hubUrl: hubUrl ?? this.hubUrl,
      deviceKey: deviceKey ?? this.deviceKey,
      selectedCalendarId: selectedCalendarId ?? this.selectedCalendarId,
      selectedCalendarName: selectedCalendarName ?? this.selectedCalendarName,
    );
  }
}

/// Almacenamiento seguro multiplataforma (Windows + Android) para URL y clave X-Device-Key.
class SecureSettingsStorage {
  SecureSettingsStorage({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              wOptions: WindowsOptions(),
            );

  static const String _keyHubUrl = 'roomboard_hub_url';
  static const String _keyDeviceKey = 'roomboard_device_key';
  static const String _keySelectedCalendarId = 'roomboard_selected_calendar_id';
  static const String _keySelectedCalendarName = 'roomboard_selected_calendar_name';

  final FlutterSecureStorage _storage;

  Future<ConnectionSettings> loadSettings() async {
    final hubUrl = await _storage.read(key: _keyHubUrl) ?? '';
    final deviceKey = await _storage.read(key: _keyDeviceKey) ?? '';
    final selectedCalendarId = await _storage.read(key: _keySelectedCalendarId);
    final selectedCalendarName = await _storage.read(key: _keySelectedCalendarName);

    return ConnectionSettings(
      hubUrl: hubUrl,
      deviceKey: deviceKey,
      selectedCalendarId: selectedCalendarId,
      selectedCalendarName: selectedCalendarName,
    );
  }

  Future<void> saveSettings(ConnectionSettings settings) async {
    await _storage.write(key: _keyHubUrl, value: settings.hubUrl.trim());
    await _storage.write(key: _keyDeviceKey, value: settings.deviceKey.trim());

    if (settings.selectedCalendarId != null && settings.selectedCalendarId!.isNotEmpty) {
      await _storage.write(
        key: _keySelectedCalendarId,
        value: settings.selectedCalendarId!.trim(),
      );
    } else {
      await _storage.delete(key: _keySelectedCalendarId);
    }

    if (settings.selectedCalendarName != null && settings.selectedCalendarName!.isNotEmpty) {
      await _storage.write(
        key: _keySelectedCalendarName,
        value: settings.selectedCalendarName!.trim(),
      );
    } else {
      await _storage.delete(key: _keySelectedCalendarName);
    }
  }

  Future<void> clearSettings() async {
    await _storage.delete(key: _keyHubUrl);
    await _storage.delete(key: _keyDeviceKey);
    await _storage.delete(key: _keySelectedCalendarId);
    await _storage.delete(key: _keySelectedCalendarName);
  }
}

