import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/core.dart';
import '../room_display/room_display_screen.dart';
import 'calendars_state.dart';
import 'widgets/agenda_view.dart';
import 'widgets/calendar_sidebar.dart';
import 'widgets/room_status_banner.dart';

/// Pantalla principal para escritorio Windows (Material 3, adaptable, con barra lateral,
/// agenda de 7 días, indicador "Ahora", estado libre/ocupada y actualización en vivo SSE).
class CalendarsScreen extends ConsumerWidget {
  const CalendarsScreen({super.key});

  void _cycleThemeMode(WidgetRef ref) {
    final current = ref.read(themeModeProvider);
    final next = switch (current) {
      ThemeMode.system => ThemeMode.light,
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
    };
    ref.read(themeModeProvider.notifier).state = next;
  }

  IconData _themeIcon(ThemeMode mode) {
    return switch (mode) {
      ThemeMode.light => Icons.light_mode_outlined,
      ThemeMode.dark => Icons.dark_mode_outlined,
      ThemeMode.system => Icons.brightness_auto_outlined,
    };
  }

  String _themeTooltip(ThemeMode mode) {
    return switch (mode) {
      ThemeMode.light => 'Tema claro (pulsa para oscuro)',
      ThemeMode.dark => 'Tema oscuro (pulsa para automático)',
      ThemeMode.system => 'Tema del sistema (pulsa para claro)',
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final calendarsAsync = ref.watch(calendarsProvider);
    final visibleIds = ref.watch(visibleCalendarIdsProvider);
    final focusedRoomId = ref.watch(focusedRoomIdProvider);
    final themeMode = ref.watch(themeModeProvider);
    final now = ref.watch(currentTimeProvider).valueOrNull ?? DateTime.now();

    final calendars = calendarsAsync.valueOrNull ?? const <CalendarInfo>[];

    if (calendars.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref
            .read(visibleCalendarIdsProvider.notifier)
            .syncInitialCalendars(calendars);
        if (focusedRoomId == null ||
            !calendars.any((c) => c.id == focusedRoomId)) {
          ref.read(focusedRoomIdProvider.notifier).state = calendars.first.id;
        }
      });
    }

    final activeRoom = calendars.where((c) => c.id == focusedRoomId).firstOrNull ??
        calendars.firstOrNull;

    final allEntries = <AgendaEventEntry>[];
    for (int i = 0; i < calendars.length; i++) {
      final cal = calendars[i];
      if (!visibleIds.contains(cal.id)) {
        continue;
      }
      final eventsAsync = ref.watch(calendarEventsProvider(cal.id));
      final calEvents = eventsAsync.valueOrNull ?? const <Event>[];
      final color = colorForCalendarIndex(i);
      for (final evt in calEvents) {
        allEntries.add(
          AgendaEventEntry(event: evt, calendar: cal, color: color),
        );
      }
    }

    final groups = buildSevenDayAgendaGroups(allEntries, now);

    void refreshAll() {
      ref.invalidate(calendarsProvider);
      for (final cal in calendars) {
        ref.invalidate(calendarEventsProvider(cal.id));
        ref.invalidate(roomStatusProvider(cal.id));
      }
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final isWideDesktop = constraints.maxWidth >= 840;

        final sidebar = CalendarSidebar(
          calendars: calendars,
          visibleIds: visibleIds,
          focusedRoomId: activeRoom?.id,
          onRefresh: refreshAll,
        );

        final mainContent = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (activeRoom != null)
              RoomStatusBanner(
                roomId: activeRoom.id,
                roomName: activeRoom.name,
              ),
            Expanded(
              child: calendarsAsync.when(
                data: (_) => AgendaView(
                  groups: groups,
                  now: now,
                ),
                loading: () => const Center(
                  child: CircularProgressIndicator(),
                ),
                error: (error, _) => Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        const Icon(
                          Icons.cloud_off_outlined,
                          size: 48,
                          color: Colors.redAccent,
                        ),
                        const SizedBox(height: 12),
                        Text(
                          'No se pudieron cargar los calendarios: $error',
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        FilledButton.icon(
                          onPressed: refreshAll,
                          icon: const Icon(Icons.refresh),
                          label: const Text('Reintentar'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        );

        return Scaffold(
          appBar: AppBar(
            title: const Text('RoomBoard — Calendarios y Agenda'),
            actions: <Widget>[
              IconButton(
                key: const Key('theme_toggle_button'),
                tooltip: _themeTooltip(themeMode),
                onPressed: () => _cycleThemeMode(ref),
                icon: Icon(_themeIcon(themeMode)),
              ),
              IconButton(
                tooltip: 'Modo pantalla de sala (Kiosco)',
                onPressed: () {
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const RoomDisplayScreen(),
                    ),
                  );
                },
                icon: const Icon(Icons.tablet_android_outlined),
              ),
              IconButton(
                key: const Key('open_settings_button'),
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
                icon: const Icon(Icons.settings_outlined),
              ),
            ],
          ),
          drawer: isWideDesktop ? null : Drawer(child: sidebar),
          body: isWideDesktop
              ? Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    SizedBox(width: 300, child: sidebar),
                    const VerticalDivider(width: 1, thickness: 1),
                    Expanded(child: mainContent),
                  ],
                )
              : mainContent,
        );
      },
    );
  }
}
