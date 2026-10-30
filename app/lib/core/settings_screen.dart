import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'api_client.dart';
import 'models.dart';
import 'providers.dart';
import 'storage.dart';

/// Pantalla de configuración inicial (URL del Hub, clave X-Device-Key y selector de calendario/sala).
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({
    super.key,
    this.onSaved,
    this.apiClientBuilder,
  });

  final VoidCallback? onSaved;
  final ApiClient Function(String hubUrl, String deviceKey)? apiClientBuilder;

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _hubUrlController;
  late final TextEditingController _deviceKeyController;

  bool _isTestingConnection = false;
  bool _isSaving = false;
  bool _obscureDeviceKey = true;

  HubHealth? _healthResult;
  String? _connectionError;
  List<CalendarInfo> _availableCalendars = const <CalendarInfo>[];
  String? _selectedCalendarId;
  bool _initializedFromProvider = false;

  @override
  void initState() {
    super.initState();
    _hubUrlController = TextEditingController(text: 'http://192.168.1.50:8080');
    _deviceKeyController = TextEditingController();
  }

  @override
  void dispose() {
    _hubUrlController.dispose();
    _deviceKeyController.dispose();
    super.dispose();
  }

  void _syncInitialValues(ConnectionSettings settings) {
    if (_initializedFromProvider) {
      return;
    }
    _initializedFromProvider = true;
    if (settings.hubUrl.isNotEmpty) {
      _hubUrlController.text = settings.hubUrl;
    }
    if (settings.deviceKey.isNotEmpty) {
      _deviceKeyController.text = settings.deviceKey;
    }
    if (settings.selectedCalendarId != null && settings.selectedCalendarId!.isNotEmpty) {
      _selectedCalendarId = settings.selectedCalendarId;
    }
  }

  ApiClient _buildClient() {
    final hubUrl = _hubUrlController.text.trim();
    final deviceKey = _deviceKeyController.text.trim();
    if (widget.apiClientBuilder != null) {
      return widget.apiClientBuilder!(hubUrl, deviceKey);
    }
    return ApiClient(hubUrl: hubUrl, deviceKey: deviceKey);
  }

  Future<void> _testConnection() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    setState(() {
      _isTestingConnection = true;
      _connectionError = null;
      _healthResult = null;
    });

    try {
      final client = _buildClient();
      final health = await client.checkHealth();
      final calendars = await client.listCalendars();

      if (!mounted) {
        return;
      }

      setState(() {
        _healthResult = health;
        _availableCalendars = calendars;
        if (calendars.isNotEmpty) {
          final stillExists =
              calendars.any((cal) => cal.id == _selectedCalendarId);
          if (!stillExists) {
            _selectedCalendarId = calendars.first.id;
          }
        }
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _connectionError = error.message;
      });
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _connectionError = 'Error inesperado al conectar con el Hub: $error';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isTestingConnection = false;
        });
      }
    }
  }

  Future<void> _saveConfiguration() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    setState(() {
      _isSaving = true;
      _connectionError = null;
    });

    try {
      CalendarInfo? selectedCal;
      for (final cal in _availableCalendars) {
        if (cal.id == _selectedCalendarId) {
          selectedCal = cal;
          break;
        }
      }

      final newSettings = ConnectionSettings(
        hubUrl: _hubUrlController.text.trim(),
        deviceKey: _deviceKeyController.text.trim(),
        selectedCalendarId: _selectedCalendarId,
        selectedCalendarName: selectedCal?.name,
      );

      await ref.read(connectionSettingsProvider.notifier).save(newSettings);

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Configuración guardada de forma segura.'),
        ),
      );
      widget.onSaved?.call();
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _connectionError = 'No se pudo guardar la configuración: $error';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(connectionSettingsProvider);
    settingsAsync.whenData(_syncInitialValues);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Configuración de RoomBoard'),
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Card(
              elevation: 2,
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        'Conexión con el Hub local',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Introduce la dirección del Hub y la clave de dispositivo (X-Device-Key).',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 24),
                      TextFormField(
                        key: const Key('hub_url_input'),
                        controller: _hubUrlController,
                        decoration: const InputDecoration(
                          labelText: 'URL del Hub',
                          hintText: 'http://192.168.1.50:8080',
                          prefixIcon: Icon(Icons.dns_outlined),
                          border: OutlineInputBorder(),
                        ),
                        keyboardType: TextInputType.url,
                        validator: (value) {
                          final trimmed = value?.trim() ?? '';
                          if (trimmed.isEmpty) {
                            return 'La URL del Hub es obligatoria.';
                          }
                          final uri = Uri.tryParse(trimmed);
                          if (uri == null ||
                              (!uri.isScheme('http') && !uri.isScheme('https')) ||
                              uri.host.isEmpty) {
                            return 'Introduce una URL válida (http:// o https://).';
                          }
                          return null;
                        },
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        key: const Key('device_key_input'),
                        controller: _deviceKeyController,
                        obscureText: _obscureDeviceKey,
                        decoration: InputDecoration(
                          labelText: 'Clave de dispositivo (X-Device-Key)',
                          prefixIcon: const Icon(Icons.vpn_key_outlined),
                          border: const OutlineInputBorder(),
                          suffixIcon: IconButton(
                            icon: Icon(
                              _obscureDeviceKey
                                  ? Icons.visibility_outlined
                                  : Icons.visibility_off_outlined,
                            ),
                            onPressed: () {
                              setState(() {
                                _obscureDeviceKey = !_obscureDeviceKey;
                              });
                            },
                          ),
                        ),
                        validator: (value) {
                          if (value == null || value.trim().isEmpty) {
                            return 'La clave de dispositivo es obligatoria.';
                          }
                          return null;
                        },
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        key: const Key('test_connection_button'),
                        onPressed: _isTestingConnection ? null : _testConnection,
                        icon: _isTestingConnection
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.network_check),
                        label: Text(
                          _isTestingConnection ? 'Probando conexión...' : 'Probar conexión',
                        ),
                      ),
                      if (_healthResult != null) ...<Widget>[
                        const SizedBox(height: 16),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.green.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: Colors.green),
                          ),
                          child: Row(
                            children: <Widget>[
                              const Icon(Icons.check_circle, color: Colors.green),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  'Conectado a ${_healthResult!.service} '
                                  '(${_healthResult!.timezone ?? "UTC"}). '
                                  'Calendarios detectados: ${_availableCalendars.length}.',
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      if (_connectionError != null) ...<Widget>[
                        const SizedBox(height: 16),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.red.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: Colors.red),
                          ),
                          child: Row(
                            children: <Widget>[
                              const Icon(Icons.error_outline, color: Colors.red),
                              const SizedBox(width: 12),
                              Expanded(child: Text(_connectionError!)),
                            ],
                          ),
                        ),
                      ],
                      const SizedBox(height: 20),
                      DropdownButtonFormField<String>(
                        key: const Key('calendar_selector_dropdown'),
                        value: _availableCalendars.any((c) => c.id == _selectedCalendarId)
                            ? _selectedCalendarId
                            : null,
                        decoration: const InputDecoration(
                          labelText: 'Calendario / Sala',
                          prefixIcon: Icon(Icons.meeting_room_outlined),
                          border: OutlineInputBorder(),
                        ),
                        hint: const Text('Prueba la conexión para elegir una sala'),
                        items: _availableCalendars
                            .map(
                              (cal) => DropdownMenuItem<String>(
                                value: cal.id,
                                child: Text(
                                  cal.ownerAddress != null
                                      ? '${cal.name} (${cal.ownerAddress})'
                                      : cal.name,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            )
                            .toList(growable: false),
                        onChanged: _availableCalendars.isEmpty
                            ? null
                            : (value) {
                                setState(() {
                                  _selectedCalendarId = value;
                                });
                              },
                      ),
                      const SizedBox(height: 24),
                      FilledButton.icon(
                        key: const Key('save_settings_button'),
                        onPressed: _isSaving ? null : _saveConfiguration,
                        icon: const Icon(Icons.save_outlined),
                        label: Text(
                          _isSaving ? 'Guardando...' : 'Guardar configuración',
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

