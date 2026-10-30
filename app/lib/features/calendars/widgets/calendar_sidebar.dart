import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/core.dart';
import '../calendars_state.dart';

/// Barra lateral con los calendarios disponibles, casillas para mostrarlos/ocultarlos
/// y selección de sala activa para el panel de estado libre/ocupada.
class CalendarSidebar extends ConsumerWidget {
  const CalendarSidebar({
    super.key,
    required this.calendars,
    required this.visibleIds,
    required this.focusedRoomId,
    required this.onRefresh,
  });

  final List<CalendarInfo> calendars;
  final Set<String> visibleIds;
  final String? focusedRoomId;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return ColoredBox(
      color: colorScheme.surfaceContainerLow,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 12, 8),
            child: Row(
              children: <Widget>[
                Icon(Icons.calendar_month_outlined, color: colorScheme.primary),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Calendarios',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: 'Actualizar calendarios',
                  onPressed: onRefresh,
                  icon: const Icon(Icons.refresh, size: 20),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              children: <Widget>[
                TextButton(
                  onPressed: calendars.isEmpty
                      ? null
                      : () => ref
                          .read(visibleCalendarIdsProvider.notifier)
                          .showAll(calendars),
                  child: const Text('Mostrar todos'),
                ),
                const SizedBox(width: 4),
                TextButton(
                  onPressed: visibleIds.isEmpty
                      ? null
                      : () =>
                          ref.read(visibleCalendarIdsProvider.notifier).hideAll(),
                  child: const Text('Ocultar todos'),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: calendars.isEmpty
                ? const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text(
                        'No se encontraron calendarios en el Hub.',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    itemCount: calendars.length,
                    itemBuilder: (context, index) {
                      final calendar = calendars[index];
                      final isChecked = visibleIds.contains(calendar.id);
                      final isFocused = calendar.id == focusedRoomId;
                      final dotColor = colorForCalendarIndex(index);

                      return Material(
                        color: isFocused
                            ? colorScheme.primaryContainer.withValues(alpha: 0.45)
                            : Colors.transparent,
                        child: ListTile(
                          key: Key('sidebar_calendar_${calendar.id}'),
                          dense: true,
                          leading: Checkbox(
                            key: Key('checkbox_calendar_${calendar.id}'),
                            value: isChecked,
                            activeColor: dotColor,
                            onChanged: (checked) {
                              ref
                                  .read(visibleCalendarIdsProvider.notifier)
                                  .toggleCalendar(
                                    calendar.id,
                                    checked ?? false,
                                  );
                            },
                          ),
                          title: Row(
                            children: <Widget>[
                              Container(
                                width: 10,
                                height: 10,
                                decoration: BoxDecoration(
                                  color: dotColor,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  calendar.name,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontWeight: isFocused
                                        ? FontWeight.bold
                                        : FontWeight.normal,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          subtitle: calendar.ownerAddress != null
                              ? Text(
                                  calendar.ownerAddress!,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodySmall,
                                )
                              : null,
                          trailing: Tooltip(
                            message: 'Ver estado de esta sala',
                            child: Icon(
                              isFocused
                                  ? Icons.radio_button_checked
                                  : Icons.meeting_room_outlined,
                              size: 18,
                              color: isFocused
                                  ? colorScheme.primary
                                  : colorScheme.onSurfaceVariant,
                            ),
                          ),
                          onTap: () {
                            ref.read(focusedRoomIdProvider.notifier).state =
                                calendar.id;
                            ref
                                .read(connectionSettingsProvider.notifier)
                                .selectCalendar(calendar);
                          },
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

