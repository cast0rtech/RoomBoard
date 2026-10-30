import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../../core/core.dart';

/// Cabecera con el estado libre/ocupada en tiempo real de la sala seleccionada.
class RoomStatusBanner extends ConsumerWidget {
  const RoomStatusBanner({
    super.key,
    required this.roomId,
    required this.roomName,
  });

  final String roomId;
  final String roomName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusAsync = ref.watch(roomStatusProvider(roomId));
    final sseConnected = ref.watch(sseConnectedProvider).valueOrNull ?? false;
    final theme = Theme.of(context);
    final timeFormat = DateFormat('HH:mm');

    return statusAsync.when(
      data: (status) {
        final isBusy = status.isBusy;
        final statusColor = isBusy ? const Color(0xFFC62828) : const Color(0xFF2E7D32);
        final statusLabel = isBusy ? 'OCUPADA' : 'LIBRE';
        final untilLocal = status.until?.toLocal();

        String subtitleText;
        if (isBusy && status.current != null) {
          final current = status.current!;
          final endStr = timeFormat.format(current.end.toLocal());
          subtitleText =
              'En curso: "${current.subject}" hasta las $endStr'
              '${current.organizer != null ? " · ${current.organizer}" : ""}';
        } else if (!isBusy && status.next != null) {
          final next = status.next!;
          final startStr = timeFormat.format(next.start.toLocal());
          subtitleText =
              'Libre hasta las $startStr · Próxima cita: "${next.subject}"';
        } else {
          subtitleText = 'Disponible el resto del día sin reuniones programadas.';
        }

        return Card(
          key: const Key('room_status_banner'),
          margin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          elevation: 1,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: statusColor.withValues(alpha: 0.5), width: 1.5),
          ),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: statusColor,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(
                        isBusy ? Icons.do_not_disturb_on : Icons.check_circle,
                        color: Colors.white,
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        statusLabel,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Flexible(
                            child: Text(
                              roomName,
                              style: theme.textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (untilLocal != null) ...<Widget>[
                            const SizedBox(width: 8),
                            Chip(
                              visualDensity: VisualDensity.compact,
                              label: Text(
                                isBusy
                                    ? 'Ocupada hasta ${timeFormat.format(untilLocal)}'
                                    : 'Libre hasta ${timeFormat.format(untilLocal)}',
                                style: theme.textTheme.labelSmall,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        subtitleText,
                        style: theme.textTheme.bodyMedium,
                        overflow: TextOverflow.ellipsis,
                        maxLines: 2,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Tooltip(
                  message: sseConnected
                      ? 'Actualización en vivo SSE conectada'
                      : 'Reconectando stream SSE...',
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(
                        Icons.sensors,
                        size: 18,
                        color: sseConnected ? Colors.green : Colors.orange,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        sseConnected ? 'En vivo' : 'SSE...',
                        style: theme.textTheme.labelSmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
      loading: () => const Card(
        margin: EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Row(
            children: <Widget>[
              SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              SizedBox(width: 12),
              Text('Consultando estado de la sala...'),
            ],
          ),
        ),
      ),
      error: (err, _) => Card(
        margin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: <Widget>[
              const Icon(Icons.warning_amber_rounded, color: Colors.orange),
              const SizedBox(width: 12),
              Expanded(child: Text('No se pudo cargar el estado de $roomName: $err')),
            ],
          ),
        ),
      ),
    );
  }
}

