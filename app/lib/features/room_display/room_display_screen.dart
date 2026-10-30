import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/core.dart';

/// Pantalla de sala para tablet: solo muestra fecha/hora y estado, junto al
/// asunto original de Outlook cuando hay una reunión activa.
class RoomDisplayScreen extends ConsumerStatefulWidget {
  const RoomDisplayScreen({super.key, this.roomId, this.roomName, this.nowOverride});

  final String? roomId;
  final String? roomName;
  final DateTime? nowOverride;

  @override
  ConsumerState<RoomDisplayScreen> createState() => _RoomDisplayScreenState();
}

class _RoomDisplayScreenState extends ConsumerState<RoomDisplayScreen> {
  Timer? _clockTimer;
  late DateTime _now;

  @override
  void initState() {
    super.initState();
    unawaited(initializeDateFormatting('de_DE'));
    _now = widget.nowOverride ?? DateTime.now();
    _enableKioskMode();
    if (widget.nowOverride == null) {
      _clockTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() => _now = DateTime.now());
      });
    }
  }

  Future<void> _enableKioskMode() async {
    try {
      await SystemChrome.setPreferredOrientations(const [
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
      await WakelockPlus.enable();
    } catch (_) {
      // Algunas plataformas de escritorio y los tests no exponen controles nativos.
    }
  }

  Future<void> _disableKioskMode() async {
    try {
      await WakelockPlus.disable();
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
      await SystemChrome.setPreferredOrientations(DeviceOrientation.values);
    } catch (_) {
      // Puede no haber una implementación nativa en la plataforma actual.
    }
  }

  @override
  void dispose() {
    _clockTimer?.cancel();
    unawaited(_disableKioskMode());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(connectionSettingsProvider).valueOrNull;
    final calendars = ref.watch(calendarsProvider).valueOrNull ?? const <CalendarInfo>[];
    final roomId = widget.roomId ?? settings?.selectedCalendarId ?? calendars.firstOrNull?.id ?? '';
    final roomName = widget.roomName ??
        settings?.selectedCalendarName ??
        calendars.where((calendar) => calendar.id == roomId).firstOrNull?.name ??
        (roomId.isNotEmpty ? roomId : 'Room');
    final statusAsync = ref.watch(roomStatusProvider(roomId));
    final sseConnected = ref.watch(sseConnectedProvider).valueOrNull ?? true;
    final status = statusAsync.valueOrNull;
    final isBusy = status?.isBusy ?? false;
    final background = isBusy ? const Color(0xFF9F1D25) : const Color(0xFF176B45);
    final offline = statusAsync.hasError || !sseConnected;
    final dateEn = DateFormat('EEEE, d MMMM yyyy', 'en_US').format(_now);
    final dateDe = DateFormat('EEEE, d. MMMM yyyy', 'de_DE').format(_now);
    final timeEn = DateFormat('h:mm:ss a', 'en_US').format(_now);
    final timeDe = DateFormat('HH:mm:ss', 'de_DE').format(_now);

    return Scaffold(
      backgroundColor: background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 48, vertical: 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.meeting_room_outlined, color: Colors.white, size: 30),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(roomName, maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white, fontSize: 25, fontWeight: FontWeight.bold)),
                        Text('$dateEn  ·  $dateDe',
                            style: const TextStyle(color: Colors.white70, fontSize: 15)),
                      ],
                    ),
                  ),
                  if (offline)
                    const Padding(
                      padding: EdgeInsets.only(right: 16),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(Icons.cloud_off, color: Colors.amberAccent, size: 18),
                        SizedBox(width: 7),
                        Text('Offline · Offline', style: TextStyle(color: Colors.white)),
                      ]),
                    ),
                  Text('$timeEn  ·  $timeDe',
                      style: const TextStyle(color: Colors.white, fontSize: 23, fontWeight: FontWeight.w700)),
                  IconButton(
                    tooltip: 'Settings · Einstellungen',
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                      builder: (settingsContext) => SettingsScreen(
                        onSaved: () => Navigator.of(settingsContext).pop(),
                      ),
                    )),
                    icon: const Icon(Icons.settings_outlined, color: Colors.white70),
                  ),
                ],
              ),
              const Spacer(),
              Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(isBusy ? 'OCCUPIED · BESETZT' : 'FREE · FREI',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white, fontSize: 66,
                            fontWeight: FontWeight.w900, letterSpacing: 2)),
                    if (isBusy && status?.current != null) ...[
                      const SizedBox(height: 20),
                      Text(status!.current!.subject,
                          key: const Key('kiosk_meeting_subject'),
                          textAlign: TextAlign.center,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Colors.white, fontSize: 34,
                              fontWeight: FontWeight.w500)),
                    ],
                  ],
                ),
              ),
              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }
}
