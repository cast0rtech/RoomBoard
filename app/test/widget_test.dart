import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:roomboard_app/core/core.dart';
import 'package:roomboard_app/features/calendars/calendars_screen.dart';
import 'package:roomboard_app/features/calendars/calendars_state.dart';
import 'package:roomboard_app/features/room_display/room_display_screen.dart';

void main() {
  group('Modelos y utilidades de RoomBoard', () {
    test('parsea Event, CalendarInfo y RoomStatus correctamente', () {
      final calendar = CalendarInfo.fromJson(const <String, dynamic>{
        'id': 'sala-goya',
        'name': 'Sala Goya',
        'ownerAddress': 'goya@empresa.com',
      });
      expect(calendar.id, 'sala-goya');
      expect(calendar.name, 'Sala Goya');

      final status = RoomStatus.fromJson(<String, dynamic>{
        'state': 'busy',
        'until': '2026-10-30T11:00:00.000Z',
        'current': <String, dynamic>{
          'id': 'evt-1',
          'subject': 'Reunión Semanal',
          'start': '2026-10-30T10:00:00.000Z',
          'end': '2026-10-30T11:00:00.000Z',
          'organizer': 'Ana Pérez',
          'isAllDay': false,
          'isCancelled': false,
          'showAs': 'busy',
          'location': 'Sala Goya',
        },
        'next': null,
      });

      expect(status.isBusy, isTrue);
      expect(status.current?.subject, 'Reunión Semanal');
      expect(status.current?.organizer, 'Ana Pérez');
      expect(status.until, DateTime.parse('2026-10-30T11:00:00.000Z'));
    });

    test('SseClient calcula backoff exponencial acotado por maxBackoff', () {
      final sse = SseClient(
        hubUrl: 'http://192.168.1.50:8080',
        deviceKey: 'clave-test',
        initialBackoff: const Duration(seconds: 1),
        maxBackoff: const Duration(seconds: 30),
      );

      expect(sse.computeBackoffDelay(0), const Duration(seconds: 1));
      expect(sse.computeBackoffDelay(1), const Duration(seconds: 2));
      expect(sse.computeBackoffDelay(2), const Duration(seconds: 4));
      expect(sse.computeBackoffDelay(6), const Duration(seconds: 30));
    });

    test('formatCountdown y filterRemainingTodayEvents formatean y filtran citas de hoy', () {
      expect(
        formatCountdown(const Duration(hours: 1, minutes: 5)),
        '1 h 05 min',
      );
      expect(
        formatCountdown(const Duration(minutes: 14, seconds: 8)),
        '14 min 08 s',
      );

      final now = DateTime(2026, 10, 30, 10, 30);
      final pastEvt = Event(
        id: 'past',
        subject: 'Pasada',
        start: DateTime(2026, 10, 30, 8, 0),
        end: DateTime(2026, 10, 30, 9, 0),
      );
      final activeEvt = Event(
        id: 'active',
        subject: 'Actual',
        start: DateTime(2026, 10, 30, 10, 0),
        end: DateTime(2026, 10, 30, 11, 0),
      );

      final remaining = filterRemainingTodayEvents(
        <Event>[pastEvt, activeEvt],
        now,
      );
      expect(remaining.length, 1);
      expect(remaining.first.id, 'active');
    });
  });

  testWidgets('Renderiza la pantalla de configuración inicial con botón Probar conexión', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: SettingsScreen(),
        ),
      ),
    );

    expect(find.text('Configuración de RoomBoard'), findsOneWidget);
    expect(find.byKey(const Key('test_connection_button')), findsOneWidget);
    expect(find.byKey(const Key('save_settings_button')), findsOneWidget);
  });

  testWidgets('Renderiza CalendarsScreen con barra lateral, estado e indicador Ahora', (
    WidgetTester tester,
  ) async {
    final now = DateTime(2026, 10, 30, 10, 30);
    const sampleCal = CalendarInfo(
      id: 'sala-norte',
      name: 'Sala Norte',
      ownerAddress: 'norte@empresa.com',
    );
    final sampleEvt = Event(
      id: 'evt-1',
      subject: 'Diseño de Producto',
      start: DateTime(2026, 10, 30, 10, 0),
      end: DateTime(2026, 10, 30, 11, 0),
      organizer: 'Marta',
      location: 'Planta 2',
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          calendarsProvider.overrideWith((_) async => const <CalendarInfo>[sampleCal]),
          currentTimeProvider.overrideWith((_) => Stream<DateTime>.value(now)),
          calendarEventsProvider('sala-norte').overrideWith(
            (_) => Stream<List<Event>>.value(<Event>[sampleEvt]),
          ),
          roomStatusProvider('sala-norte').overrideWith(
            (_) => Stream<RoomStatus>.value(
              RoomStatus(
                state: RoomState.busy,
                current: sampleEvt,
                until: sampleEvt.end,
              ),
            ),
          ),
        ],
        child: const MaterialApp(
          home: CalendarsScreen(),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('RoomBoard — Calendarios y Agenda'), findsOneWidget);
    expect(find.byKey(const Key('now_indicator')), findsOneWidget);
    expect(find.text('Diseño de Producto'), findsOneWidget);
  });

  testWidgets('Renderiza RoomDisplayScreen en modo kiosco con estado OCUPADA y cuenta atrás', (
    WidgetTester tester,
  ) async {
    final now = DateTime(2026, 10, 30, 10, 30);
    final currentEvt = Event(
      id: 'evt-curr',
      subject: 'Comité Ejecutivo',
      start: DateTime(2026, 10, 30, 10, 0),
      end: DateTime(2026, 10, 30, 11, 0),
      organizer: 'Dirección',
    );
    final nextEvt = Event(
      id: 'evt-next',
      subject: 'Sprint Review',
      start: DateTime(2026, 10, 30, 11, 15),
      end: DateTime(2026, 10, 30, 12, 0),
      organizer: 'Equipo Dev',
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sseConnectedProvider.overrideWith((_) => Stream<bool>.value(false)),
          calendarEventsProvider('sala-kiosco').overrideWith(
            (_) => Stream<List<Event>>.value(<Event>[currentEvt, nextEvt]),
          ),
          roomStatusProvider('sala-kiosco').overrideWith(
            (_) => Stream<RoomStatus>.value(
              RoomStatus(
                state: RoomState.busy,
                current: currentEvt,
                next: nextEvt,
                until: currentEvt.end,
              ),
            ),
          ),
        ],
        child: MaterialApp(
          home: RoomDisplayScreen(
            roomId: 'sala-kiosco',
            roomName: 'Sala Kiosco Principal',
            nowOverride: now,
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('OCUPADA'), findsOneWidget);
    expect(find.text('Comité Ejecutivo'), findsWidgets);
    expect(find.text('Sprint Review'), findsWidgets);
    expect(find.byKey(const Key('kiosk_offline_warning')), findsOneWidget);
  });

  testWidgets('RoomDisplayScreen muestra botones de reserva rápida cuando la sala está LIBRE', (
    WidgetTester tester,
  ) async {
    final now = DateTime(2026, 10, 30, 10, 30);

    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sseConnectedProvider.overrideWith((_) => Stream<bool>.value(true)),
          calendarEventsProvider('sala-libre').overrideWith(
            (_) => Stream<List<Event>>.value(const <Event>[]),
          ),
          roomStatusProvider('sala-libre').overrideWith(
            (_) => Stream<RoomStatus>.value(
              const RoomStatus(state: RoomState.free),
            ),
          ),
        ],
        child: MaterialApp(
          home: RoomDisplayScreen(
            roomId: 'sala-libre',
            roomName: 'Sala Libre 1',
            nowOverride: now,
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('LIBRE'), findsOneWidget);
    expect(find.byKey(const Key('book_15_button')), findsOneWidget);
    expect(find.byKey(const Key('book_30_button')), findsOneWidget);
    expect(find.byKey(const Key('book_60_button')), findsOneWidget);

    // Al pulsar "Reservar 15 min", abre el diálogo de confirmación
    await tester.tap(find.byKey(const Key('book_15_button')));
    await tester.pumpAndSettle();

    expect(find.text('Reserva rápida (15 min)'), findsOneWidget);
    expect(find.byKey(const Key('confirm_booking_button')), findsOneWidget);
  });
}
