import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import '../../core/core.dart';
import '../calendars/calendars_screen.dart';

/// Formatea una duración de cuenta atrás de forma legible (p. ej. "1 h 15 min" o "14 min 20 s").
String formatCountdown(Duration remaining) {
  if (remaining.isNegative || remaining.inSeconds <= 0) {
    return 'Ahora mismo';
  }
  final hours = remaining.inHours;
  final minutes = remaining.inMinutes.remainder(60);
  final seconds = remaining.inSeconds.remainder(60);

  if (hours > 0) {
    return '${hours} h ${minutes.toString().padLeft(2, '0')} min';
  }
  if (minutes > 0) {
    return '$minutes min ${seconds.toString().padLeft(2, '0')} s';
  }
  return '$seconds s';
}

/// Filtra y ordena la lista corta de citas restantes para el día de hoy.
List<Event> filterRemainingTodayEvents(
  List<Event> events,
  DateTime now, {
  int maxCount = 5,
}) {
  final localNow = now.toLocal();
  final endOfToday = DateTime(localNow.year, localNow.month, localNow.day, 23, 59, 59);

  final remaining = events.where((event) {
    if (event.isCancelled) {
      return false;
    }
    final startLocal = event.start.toLocal();
    final endLocal = event.end.toLocal();
    return endLocal.isAfter(localNow) && startLocal.isBefore(endOfToday);
  }).toList();

  remaining.sort((a, b) => a.start.compareTo(b.start));
  if (remaining.length > maxCount) {
    return remaining.sublist(0, maxCount);
  }
  return remaining;
}

/// Pantalla de sala en modo kiosco para tablet a pantalla completa.
/// - Verde = LIBRE, Rojo = OCUPADA.
/// - Orientación horizontal, barras del sistema ocultas (immersiveSticky) y wakelock activo.
/// - Botones de reserva rápida (15 / 30 / 60 min) visibles solo cuando la sala está libre.
class RoomDisplayScreen extends ConsumerStatefulWidget {
  const RoomDisplayScreen({
    super.key,
    this.roomId,
    this.roomName,
    this.nowOverride,
  });

  final String? roomId;
  final String? roomName;
  final DateTime? nowOverride;

  @override
  ConsumerState<RoomDisplayScreen> createState() => _RoomDisplayScreenState();
}

class _RoomDisplayScreenState extends ConsumerState<RoomDisplayScreen> {
  static const Color kFreeBackgroundColor = Color(0xFF1B5E20);
  static const Color kBusyBackgroundColor = Color(0xFFB71C1C);

  Timer? _clockTimer;
  late DateTime _now;
  bool _isBooking = false;

  @override
  void initState() {
    super.initState();
    _now = widget.nowOverride ?? DateTime.now();
    _enableKioskMode();

    if (widget.nowOverride == null) {
      _clockTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) {
          setState(() {
            _now = DateTime.now();
          });
        }
      });
    }
  }

  Future<void> _enableKioskMode() async {
    try {
      await SystemChrome.setPreferredOrientations(const <DeviceOrientation>[
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
      await WakelockPlus.enable();
    } catch (_) {
      // En tests de widgets o plataformas de escritorio donde no aplique el plugin nativo, continuamos sin fallo.
    }
  }

  Future<void> _disableKioskMode() async {
    try {
      await WakelockPlus.disable();
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
      await SystemChrome.setPreferredOrientations(DeviceOrientation.values);
    } catch (_) {
      // Ignoramos errores al restaurar orientación en tests.
    }
  }

  @override
  void dispose() {
    _clockTimer?.cancel();
    unawaited(_disableKioskMode());
    super.dispose();
  }

  Future<void> _promptQuickBook(
    BuildContext context,
    String roomId,
    String roomName,
    int minutes,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text('Reserva rápida ($minutes min)'),
        content: Text(
          '¿Deseas reservar "$roomName" durante los próximos $minutes minutos?',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            key: const Key('confirm_booking_button'),
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: const Text('Confirmar reserva'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) {
      return;
    }

    setState(() {
      _isBooking = true;
    });

    try {
      final api = ref.read(apiClientProvider);
      if (api == null) {
        throw const ApiException('No hay conexión configurada con el Hub.');
      }

      await api.bookRoom(roomId, minutes);
      if (!mounted) {
        return;
      }

      ref.invalidate(roomStatusProvider(roomId));
      ref.invalidate(calendarEventsProvider(roomId));

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: Colors.teal.shade800,
          content: Text('Sala reservada con éxito por $minutes minutos.'),
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: Colors.red.shade900,
          content: Text(error.message),
        ),
      );
    } catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: Colors.red.shade900,
          content: Text('Error al reservar: $error'),
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isBooking = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(connectionSettingsProvider).valueOrNull;
    final calendars = ref.watch(calendarsProvider).valueOrNull ?? const <CalendarInfo>[];

    final effectiveRoomId = widget.roomId ??
        settings?.selectedCalendarId ??
        calendars.firstOrNull?.id ??
        '';
    final effectiveRoomName = widget.roomName ??
        settings?.selectedCalendarName ??
        calendars.where((c) => c.id == effectiveRoomId).firstOrNull?.name ??
        (effectiveRoomId.isNotEmpty ? effectiveRoomId : 'Sala Principal');

    final statusAsync = ref.watch(roomStatusProvider(effectiveRoomId));
    final eventsAsync = ref.watch(calendarEventsProvider(effectiveRoomId));
    final sseConnected = ref.watch(sseConnectedProvider).valueOrNull ?? true;

    final status = statusAsync.valueOrNull ?? const RoomStatus(state: RoomState.free);
    final isBusy = status.isBusy;
    final backgroundColor = isBusy ? kBusyBackgroundColor : kFreeBackgroundColor;

    final allEvents = eventsAsync.valueOrNull ?? const <Event>[];
    final todayEvents = filterRemainingTodayEvents(allEvents, _now);

    final hasConnectionProblem = statusAsync.hasError || eventsAsync.hasError || !sseConnected;

    final timeFormat = DateFormat('HH:mm');
    final clockFormat = DateFormat('HH:mm:ss');
    final dateFormat = DateFormat('EEEE, d MMM yyyy');

    return Scaffold(
      key: const Key('room_display_scaffold'),
      backgroundColor: backgroundColor,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // Barra superior: nombre de la sala, aviso discreto de desconexión y reloj en vivo
              Row(
                children: <Widget>[
                  const Icon(
                    Icons.meeting_room_outlined,
                    color: Colors.white,
                    size: 32,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          effectiveRoomName,
                          key: const Key('kiosk_room_name'),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 28,
                            fontWeight: FontWeight.bold,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          dateFormat.format(_now.toLocal()),
                          style: const TextStyle(
                            color: Colors.white70,
                            fontSize: 15,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (hasConnectionProblem)
                    Container(
                      key: const Key('kiosk_offline_warning'),
                      margin: const EdgeInsets.only(right: 16),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.35),
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(color: Colors.amberAccent),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Icon(
                            Icons.cloud_off,
                            color: Colors.amberAccent,
                            size: 16,
                          ),
                          SizedBox(width: 6),
                          Text(
                            'Sin conexión con el Hub · Reintentando...',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                  Text(
                    clockFormat.format(_now.toLocal()),
                    key: const Key('kiosk_live_clock'),
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 34,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.2,
                    ),
                  ),
                  const SizedBox(width: 12),
                  IconButton(
                    tooltip: 'Ver agenda completa',
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const CalendarsScreen(),
                        ),
                      );
                    },
                    icon: const Icon(
                      Icons.view_agenda_outlined,
                      color: Colors.white70,
                    ),
                  ),
                  IconButton(
                    tooltip: 'Configuración del Hub',
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (ctx) => SettingsScreen(
                            onSaved: () => Navigator.of(ctx).pop(),
                          ),
                        ),
                      );
                    },
                    icon: const Icon(
                      Icons.settings_outlined,
                      color: Colors.white70,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              // Cuerpo principal en dos columnas: Estado + Reunión actual/siguiente (izq) y Resto del día (der)
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Expanded(
                      flex: 3,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          Text(
                            isBusy ? 'OCUPADA' : 'LIBRE',
                            key: const Key('kiosk_state_headline'),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 80,
                              fontWeight: FontWeight.w900,
                              height: 1.0,
                              letterSpacing: 2.0,
                            ),
                          ),
                          const SizedBox(height: 12),
                          if (status.until != null)
                            Text(
                              isBusy
                                  ? 'Ocupada hasta las ${timeFormat.format(status.until!.toLocal())} '
                                      '(${formatCountdown(status.until!.difference(_now))} restantes)'
                                  : 'Disponible hasta las ${timeFormat.format(status.until!.toLocal())}',
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 22,
                                fontWeight: FontWeight.w500,
                              ),
                            )
                          else if (!isBusy)
                            const Text(
                              'Disponible durante el resto del día',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 22,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          const SizedBox(height: 24),
                          // Si está libre: botones de reserva rápida
                          if (!isBusy) ...<Widget>[
                            const Text(
                              'RESERVA RÁPIDA DE SALA',
                              style: TextStyle(
                                color: Colors.white70,
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                                letterSpacing: 1.2,
                              ),
                            ),
                            const SizedBox(height: 10),
                            Wrap(
                              spacing: 12,
                              runSpacing: 8,
                              children: <Widget>[
                                _QuickBookButton(
                                  key: const Key('book_15_button'),
                                  minutes: 15,
                                  isLoading: _isBooking,
                                  onPressed: () => _promptQuickBook(
                                    context,
                                    effectiveRoomId,
                                    effectiveRoomName,
                                    15,
                                  ),
                                ),
                                _QuickBookButton(
                                  key: const Key('book_30_button'),
                                  minutes: 30,
                                  isLoading: _isBooking,
                                  onPressed: () => _promptQuickBook(
                                    context,
                                    effectiveRoomId,
                                    effectiveRoomName,
                                    30,
                                  ),
                                ),
                                _QuickBookButton(
                                  key: const Key('book_60_button'),
                                  minutes: 60,
                                  isLoading: _isBooking,
                                  onPressed: () => _promptQuickBook(
                                    context,
                                    effectiveRoomId,
                                    effectiveRoomName,
                                    60,
                                  ),
                                ),
                              ],
                            ),
                          ],
                          if (isBusy && status.current != null)
                            _CurrentMeetingCard(
                              event: status.current!,
                              timeFormat: timeFormat,
                            ),
                          if (status.next != null) ...<Widget>[
                            const SizedBox(height: 16),
                            _NextMeetingCard(
                              event: status.next!,
                              now: _now,
                              timeFormat: timeFormat,
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 28),
                    // Panel lateral: citas del resto del día
                    Expanded(
                      flex: 2,
                      child: _RemainingDaySchedulePanel(
                        events: todayEvents,
                        now: _now,
                        timeFormat: timeFormat,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QuickBookButton extends StatelessWidget {
  const _QuickBookButton({
    super.key,
    required this.minutes,
    required this.onPressed,
    this.isLoading = false,
  });

  final int minutes;
  final VoidCallback onPressed;
  final bool isLoading;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      style: FilledButton.styleFrom(
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1B5E20),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      onPressed: isLoading ? null : onPressed,
      icon: isLoading
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.flash_on, size: 20),
      label: Text(
        'Reservar $minutes min',
        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
      ),
    );
  }
}

class _CurrentMeetingCard extends StatelessWidget {
  const _CurrentMeetingCard({
    required this.event,
    required this.timeFormat,
  });

  final Event event;
  final DateFormat timeFormat;

  @override
  Widget build(BuildContext context) {
    final rangeStr =
        '${timeFormat.format(event.start.toLocal())} – ${timeFormat.format(event.end.toLocal())}';

    return Container(
      key: const Key('kiosk_current_meeting_card'),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.25),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white30),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            'REUNIÓN ACTUAL',
            style: TextStyle(
              color: Colors.white70,
              fontSize: 13,
              fontWeight: FontWeight.bold,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            event.subject,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 28,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 20,
            runSpacing: 6,
            children: <Widget>[
              Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const Icon(Icons.access_time, color: Colors.white70, size: 18),
                  const SizedBox(width: 6),
                  Text(
                    rangeStr,
                    style: const TextStyle(color: Colors.white, fontSize: 17),
                  ),
                ],
              ),
              if (event.organizer != null && event.organizer!.isNotEmpty)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.person_outline, color: Colors.white70, size: 18),
                    const SizedBox(width: 6),
                    Text(
                      event.organizer!,
                      style: const TextStyle(color: Colors.white, fontSize: 17),
                    ),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _NextMeetingCard extends StatelessWidget {
  const _NextMeetingCard({
    required this.event,
    required this.now,
    required this.timeFormat,
  });

  final Event event;
  final DateTime now;
  final DateFormat timeFormat;

  @override
  Widget build(BuildContext context) {
    final rangeStr =
        '${timeFormat.format(event.start.toLocal())} – ${timeFormat.format(event.end.toLocal())}';
    final countdown = formatCountdown(event.start.difference(now));

    return Container(
      key: const Key('kiosk_next_meeting_card'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.2),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white24),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text(
                  'SIGUIENTE REUNIÓN',
                  style: TextStyle(
                    color: Colors.white70,
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1.1,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  event.subject,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(
                  '$rangeStr${event.organizer != null ? " · ${event.organizer}" : ""}',
                  style: const TextStyle(color: Colors.white70, fontSize: 15),
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.18),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              children: <Widget>[
                const Text(
                  'COMIENZA EN',
                  style: TextStyle(
                    color: Colors.white70,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  countdown,
                  key: const Key('kiosk_next_countdown'),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RemainingDaySchedulePanel extends StatelessWidget {
  const _RemainingDaySchedulePanel({
    required this.events,
    required this.now,
    required this.timeFormat,
  });

  final List<Event> events;
  final DateTime now;
  final DateFormat timeFormat;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('kiosk_today_schedule_panel'),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.22),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white24),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const Row(
            children: <Widget>[
              Icon(Icons.schedule, color: Colors.white, size: 20),
              SizedBox(width: 8),
              Text(
                'CITAS DEL RESTO DEL DÍA',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1.1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Divider(color: Colors.white24, height: 1),
          const SizedBox(height: 12),
          Expanded(
            child: events.isEmpty
                ? const Center(
                    child: Text(
                      'No hay más citas programadas para hoy.',
                      style: TextStyle(color: Colors.white70, fontSize: 16),
                      textAlign: TextAlign.center,
                    ),
                  )
                : ListView.separated(
                    itemCount: events.length,
                    separatorBuilder: (_, __) =>
                        const Divider(color: Colors.white12, height: 16),
                    itemBuilder: (context, index) {
                      final evt = events[index];
                      final isNow = !now.isBefore(evt.start.toLocal()) &&
                          now.isBefore(evt.end.toLocal());
                      final timeRange = evt.isAllDay
                          ? 'Todo el día'
                          : '${timeFormat.format(evt.start.toLocal())} – ${timeFormat.format(evt.end.toLocal())}';

                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          SizedBox(
                            width: 110,
                            child: Text(
                              timeRange,
                              style: TextStyle(
                                color: isNow ? Colors.amberAccent : Colors.white,
                                fontWeight: FontWeight.bold,
                                fontSize: 14,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(
                                  evt.subject,
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w600,
                                    fontSize: 15,
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                                if (evt.organizer != null &&
                                    evt.organizer!.isNotEmpty)
                                  Text(
                                    evt.organizer!,
                                    style: const TextStyle(
                                      color: Colors.white70,
                                      fontSize: 13,
                                    ),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                              ],
                            ),
                          ),
                        ],
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
