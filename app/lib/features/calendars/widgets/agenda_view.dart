import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../calendars_state.dart';

/// Vista de agenda con las citas de hoy y de los próximos 7 días agrupadas por día,
/// incluyendo el indicador visual "Ahora".
class AgendaView extends StatelessWidget {
  const AgendaView({
    super.key,
    required this.groups,
    required this.now,
  });

  final List<DayAgendaGroup> groups;
  final DateTime now;

  String _formatDayTitle(DateTime date, DateTime localNow) {
    final today = DateTime(localNow.year, localNow.month, localNow.day);
    final tomorrow = today.add(const Duration(days: 1));
    final dateOnly = DateTime(date.year, date.month, date.day);

    final formattedDate = DateFormat('EEEE, d MMM yyyy').format(dateOnly);
    if (dateOnly == today) {
      return 'Hoy · $formattedDate';
    }
    if (dateOnly == tomorrow) {
      return 'Mañana · $formattedDate';
    }
    return formattedDate;
  }

  @override
  Widget build(BuildContext context) {
    final localNow = now.toLocal();

    if (groups.isEmpty) {
      return const Center(
        child: Text('No hay citas programadas para hoy ni los próximos 7 días.'),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      itemCount: groups.length,
      itemBuilder: (context, index) {
        final group = groups[index];
        return _DaySection(
          group: group,
          dayTitle: _formatDayTitle(group.date, localNow),
          now: localNow,
        );
      },
    );
  }
}

class _DaySection extends StatelessWidget {
  const _DaySection({
    required this.group,
    required this.dayTitle,
    required this.now,
  });

  final DayAgendaGroup group;
  final String dayTitle;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final widgets = <Widget>[];
    bool nowInserted = false;

    for (final entry in group.entries) {
      final eventStart = entry.event.start.toLocal();
      if (group.isToday && !nowInserted && eventStart.isAfter(now)) {
        widgets.add(_NowIndicatorRow(now: now));
        nowInserted = true;
      }
      widgets.add(
        _AgendaEventCard(
          entry: entry,
          isActiveNow: group.isToday && isEventActiveAt(entry.event, now),
        ),
      );
    }

    if (group.isToday && !nowInserted) {
      widgets.add(_NowIndicatorRow(now: now));
    }

    if (!group.isToday && group.entries.isEmpty) {
      return const SizedBox.shrink();
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: group.isToday
                  ? colorScheme.primaryContainer.withValues(alpha: 0.6)
                  : colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  group.isToday ? Icons.today : Icons.event_note_outlined,
                  size: 18,
                  color: group.isToday
                      ? colorScheme.onPrimaryContainer
                      : colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    dayTitle,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: group.isToday
                          ? colorScheme.onPrimaryContainer
                          : colorScheme.onSurface,
                    ),
                  ),
                ),
                Text(
                  '${group.entries.length} cita(s)',
                  style: theme.textTheme.labelMedium,
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          if (group.entries.isEmpty && group.isToday)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
              child: Text(
                'Sin citas programadas para hoy.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ...widgets,
        ],
      ),
    );
  }
}

class _NowIndicatorRow extends StatelessWidget {
  const _NowIndicatorRow({required this.now});

  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final timeStr = DateFormat('HH:mm').format(now);
    const indicatorColor = Color(0xFFD32F2F);

    return Padding(
      key: const Key('now_indicator'),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: indicatorColor,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              'AHORA · $timeStr',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 11,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 8),
          const Expanded(
            child: Divider(
              color: indicatorColor,
              thickness: 2,
              height: 2,
            ),
          ),
        ],
      ),
    );
  }
}

class _AgendaEventCard extends StatelessWidget {
  const _AgendaEventCard({
    required this.entry,
    required this.isActiveNow,
  });

  final AgendaEventEntry entry;
  final bool isActiveNow;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final event = entry.event;
    final timeFormat = DateFormat('HH:mm');

    final timeLabel = event.isAllDay
        ? 'Todo el día'
        : '${timeFormat.format(event.start.toLocal())} – ${timeFormat.format(event.end.toLocal())}';

    return Card(
      key: Key('agenda_event_${event.id}'),
      margin: const EdgeInsets.symmetric(vertical: 4),
      elevation: isActiveNow ? 2 : 0.5,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(
          color: isActiveNow
              ? entry.color
              : colorScheme.outlineVariant.withValues(alpha: 0.6),
          width: isActiveNow ? 1.8 : 1,
        ),
      ),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Container(
              width: 6,
              decoration: BoxDecoration(
                color: entry.color,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(10),
                  bottomLeft: Radius.circular(10),
                ),
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Icon(
                          Icons.schedule,
                          size: 16,
                          color: colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          timeLabel,
                          style: theme.textTheme.labelLarge?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: entry.color.withValues(alpha: 0.14),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            entry.calendar.name,
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: entry.color,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        const Spacer(),
                        if (isActiveNow)
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: const Color(0xFFC62828),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const Text(
                              'EN CURSO',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      event.subject,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 16,
                      runSpacing: 4,
                      children: <Widget>[
                        if (event.organizer != null &&
                            event.organizer!.trim().isNotEmpty)
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Icon(
                                Icons.person_outline,
                                size: 16,
                                color: colorScheme.onSurfaceVariant,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                event.organizer!,
                                style: theme.textTheme.bodySmall,
                              ),
                            ],
                          ),
                        if (event.location != null &&
                            event.location!.trim().isNotEmpty)
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Icon(
                                Icons.place_outlined,
                                size: 16,
                                color: colorScheme.onSurfaceVariant,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                event.location!,
                                style: theme.textTheme.bodySmall,
                              ),
                            ],
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

