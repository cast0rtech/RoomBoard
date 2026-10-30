import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/core.dart';

/// Paleta de colores distintivos para identificar cada calendario en la agenda.
const List<Color> kCalendarPalette = <Color>[
  Color(0xFF00796B),
  Color(0xFF1976D2),
  Color(0xFF7B1FA2),
  Color(0xFFE64A19),
  Color(0xFF388E3C),
  Color(0xFFC2185B),
  Color(0xFF0288D1),
  Color(0xFFF57C00),
];

Color colorForCalendarIndex(int index) {
  return kCalendarPalette[index % kCalendarPalette.length];
}

/// Evento enriquecido con la información y el color del calendario al que pertenece.
class AgendaEventEntry {
  const AgendaEventEntry({
    required this.event,
    required this.calendar,
    required this.color,
  });

  final Event event;
  final CalendarInfo calendar;
  final Color color;
}

/// Grupo de eventos correspondientes a un día concreto dentro de la ventana de hoy + 7 días.
class DayAgendaGroup {
  const DayAgendaGroup({
    required this.date,
    required this.isToday,
    required this.entries,
  });

  final DateTime date;
  final bool isToday;
  final List<AgendaEventEntry> entries;
}

/// Comprueba si un evento está en curso en el instante `now`.
bool isEventActiveAt(Event event, DateTime now) {
  if (event.isCancelled) {
    return false;
  }
  final startLocal = event.start.toLocal();
  final endLocal = event.end.toLocal();
  return !now.isBefore(startLocal) && now.isBefore(endLocal);
}

/// Agrupa y ordena cronológicamente las citas para hoy y los próximos 7 días.
List<DayAgendaGroup> buildSevenDayAgendaGroups(
  List<AgendaEventEntry> allEntries,
  DateTime now,
) {
  final localNow = now.toLocal();
  final todayStart = DateTime(localNow.year, localNow.month, localNow.day);
  final windowEnd = todayStart.add(const Duration(days: 8));

  final validEntries = allEntries.where((entry) {
    if (entry.event.isCancelled) {
      return false;
    }
    final start = entry.event.start.toLocal();
    final end = entry.event.end.toLocal();
    return end.isAfter(todayStart) && start.isBefore(windowEnd);
  }).toList();

  validEntries.sort((a, b) {
    final cmp = a.event.start.compareTo(b.event.start);
    if (cmp != 0) {
      return cmp;
    }
    return a.event.end.compareTo(b.event.end);
  });

  final groups = <DayAgendaGroup>[];
  for (int offset = 0; offset <= 7; offset++) {
    final dayStart = todayStart.add(Duration(days: offset));
    final dayEnd = dayStart.add(const Duration(days: 1));

    final dayEntries = validEntries.where((entry) {
      final start = entry.event.start.toLocal();
      final end = entry.event.end.toLocal();
      return start.isBefore(dayEnd) && end.isAfter(dayStart);
    }).toList(growable: false);

    if (dayEntries.isNotEmpty || offset == 0) {
      groups.add(
        DayAgendaGroup(
          date: dayStart,
          isToday: offset == 0,
          entries: dayEntries,
        ),
      );
    }
  }

  return groups;
}

/// Gestiona el conjunto de IDs de calendarios visibles (marcados en la barra lateral).
class VisibleCalendarsNotifier extends StateNotifier<Set<String>> {
  VisibleCalendarsNotifier() : super(const <String>{});

  bool _initialized = false;

  void syncInitialCalendars(List<CalendarInfo> calendars) {
    if (_initialized || calendars.isEmpty) {
      return;
    }
    _initialized = true;
    state = calendars.map((c) => c.id).toSet();
  }

  void toggleCalendar(String calendarId, bool visible) {
    final next = Set<String>.from(state);
    if (visible) {
      next.add(calendarId);
    } else {
      next.remove(calendarId);
    }
    state = next;
  }

  void showAll(List<CalendarInfo> calendars) {
    state = calendars.map((c) => c.id).toSet();
  }

  void hideAll() {
    state = const <String>{};
  }
}

final visibleCalendarIdsProvider =
    StateNotifierProvider<VisibleCalendarsNotifier, Set<String>>((ref) {
  return VisibleCalendarsNotifier();
});

/// ID de la sala actualmente seleccionada para mostrar su estado libre/ocupada en tiempo real.
final focusedRoomIdProvider = StateProvider<String?>((ref) {
  final settings = ref.watch(connectionSettingsProvider).valueOrNull;
  return settings?.selectedCalendarId;
});

/// Reloj reactivo que emite la hora actual cada 30 segundos para actualizar el indicador "Ahora".
final currentTimeProvider = StreamProvider<DateTime>((ref) async* {
  yield DateTime.now();
  yield* Stream<DateTime>.periodic(
    const Duration(seconds: 30),
    (_) => DateTime.now(),
  );
});

