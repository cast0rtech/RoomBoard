import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'api_client.dart';
import 'models.dart';

/// Tipos de evento emitidos por el canal SSE del Hub (`/api/stream`).
enum SseEventType { status, events, heartbeat, unknown }

/// Evento tipado recibido desde `/api/stream`.
class SseMessage {
  const SseMessage({
    required this.type,
    this.calendarId,
    this.status,
    this.events,
    this.timestamp,
  });

  final SseEventType type;
  final String? calendarId;
  final RoomStatus? status;
  final List<Event>? events;
  final DateTime? timestamp;
}

/// Cliente Server-Sent Events (SSE) con reconexión automática mediante backoff exponencial.
class SseClient {
  SseClient({
    required String hubUrl,
    required String deviceKey,
    this.calendarId,
    this.initialBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    Dio? dio,
  })  : _hubUrl = ApiClient.normalizeBaseUrl(hubUrl),
        _deviceKey = deviceKey.trim(),
        _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: ApiClient.normalizeBaseUrl(hubUrl),
                connectTimeout: const Duration(seconds: 10),
                receiveTimeout: Duration.zero,
              ),
            );

  final String _hubUrl;
  final String _deviceKey;
  final String? calendarId;
  final Duration initialBackoff;
  final Duration maxBackoff;
  final Dio _dio;

  final StreamController<SseMessage> _messageController =
      StreamController<SseMessage>.broadcast();
  final StreamController<bool> _connectedController =
      StreamController<bool>.broadcast();

  CancelToken? _cancelToken;
  Timer? _reconnectTimer;
  bool _disposed = false;
  bool _running = false;
  int _attempt = 0;

  Stream<SseMessage> get messages => _messageController.stream;
  Stream<bool> get connectionChanges => _connectedController.stream;
  String get hubUrl => _hubUrl;

  /// Calcula el tiempo de espera con backoff exponencial acotado por `maxBackoff`.
  Duration computeBackoffDelay(int attempt) {
    final multiplier = pow(2, attempt.clamp(0, 10)).toInt();
    final delayMs = initialBackoff.inMilliseconds * multiplier;
    final boundedMs = min(delayMs, maxBackoff.inMilliseconds);
    return Duration(milliseconds: boundedMs);
  }

  /// Inicia la conexión SSE y mantiene la reconexión automática.
  void connect() {
    if (_disposed || _running) {
      return;
    }
    _running = true;
    _openStream();
  }

  Future<void> _openStream() async {
    if (_disposed || !_running) {
      return;
    }

    _cancelToken?.cancel();
    final token = CancelToken();
    _cancelToken = token;

    try {
      final queryParams = <String, dynamic>{
        if (calendarId != null && calendarId!.isNotEmpty) 'calendarId': calendarId,
      };

      final response = await _dio.get<ResponseBody>(
        '/api/stream',
        queryParameters: queryParams,
        cancelToken: token,
        options: Options(
          responseType: ResponseType.stream,
          headers: <String, dynamic>{
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Device-Key': _deviceKey,
          },
        ),
      );

      final body = response.data;
      if (body == null) {
        _scheduleReconnect();
        return;
      }

      _attempt = 0;
      if (!_connectedController.isClosed) {
        _connectedController.add(true);
      }

      final lineStream = body.stream
          .map((Uint8List chunk) => List<int>.from(chunk))
          .transform(utf8.decoder)
          .transform(const LineSplitter());

      String currentEvent = 'message';
      final dataLines = <String>[];

      await for (final line in lineStream) {
        if (_disposed || token.isCancelled) {
          break;
        }

        if (line.startsWith(':')) {
          if (line.contains('heartbeat') && !_messageController.isClosed) {
            _messageController.add(
              SseMessage(type: SseEventType.heartbeat, timestamp: DateTime.now()),
            );
          }
          continue;
        }

        if (line.isEmpty) {
          if (dataLines.isNotEmpty) {
            _dispatchParsedFrame(currentEvent, dataLines.join('\n'));
            dataLines.clear();
          }
          currentEvent = 'message';
          continue;
        }

        if (line.startsWith('event:')) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.add(line.substring(5).trim());
        }
      }

      if (!_disposed && _running) {
        _scheduleReconnect();
      }
    } catch (_) {
      if (!_disposed && _running) {
        _scheduleReconnect();
      }
    }
  }

  void _dispatchParsedFrame(String eventName, String rawJson) {
    if (_messageController.isClosed) {
      return;
    }

    try {
      final decoded = jsonDecode(rawJson);
      if (decoded is! Map<String, dynamic>) {
        return;
      }

      final calId = decoded['calendarId'] as String?;
      final tsRaw = decoded['timestamp'] as String?;
      final ts = tsRaw != null ? DateTime.tryParse(tsRaw) : null;

      if (eventName == 'status') {
        final statusMap = decoded['status'];
        if (statusMap is Map<String, dynamic>) {
          _messageController.add(
            SseMessage(
              type: SseEventType.status,
              calendarId: calId,
              status: RoomStatus.fromJson(statusMap),
              timestamp: ts,
            ),
          );
        }
      } else if (eventName == 'events') {
        final rawList = decoded['events'];
        if (rawList is List) {
          final parsedEvents = rawList
              .whereType<Map<String, dynamic>>()
              .map(Event.fromJson)
              .toList(growable: false);
          _messageController.add(
            SseMessage(
              type: SseEventType.events,
              calendarId: calId,
              events: parsedEvents,
              timestamp: ts,
            ),
          );
        }
      }
    } catch (_) {
      // Ignoramos tramas malformadas sin interrumpir el stream
    }
  }

  void _scheduleReconnect() {
    if (_disposed || !_running) {
      return;
    }
    if (!_connectedController.isClosed) {
      _connectedController.add(false);
    }

    _reconnectTimer?.cancel();
    final delay = computeBackoffDelay(_attempt);
    _attempt += 1;
    _reconnectTimer = Timer(delay, _openStream);
  }

  /// Cierra la conexión actual y libera los recursos del cliente SSE.
  Future<void> dispose() async {
    _disposed = true;
    _running = false;
    _reconnectTimer?.cancel();
    _cancelToken?.cancel();
    await _messageController.close();
    await _connectedController.close();
  }
}

