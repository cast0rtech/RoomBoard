import 'package:dio/dio.dart';
import 'models.dart';

/// Excepción explícita para errores al comunicarse con el Hub local.
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() =>
      statusCode != null ? 'ApiException($statusCode): $message' : 'ApiException: $message';
}

/// Cliente HTTP basado en Dio para comunicarse exclusivamente con el Hub de RoomBoard.
class ApiClient {
  ApiClient({
    required String hubUrl,
    required String deviceKey,
    Dio? dio,
  })  : _hubUrl = normalizeBaseUrl(hubUrl),
        _deviceKey = deviceKey.trim(),
        _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: normalizeBaseUrl(hubUrl),
                connectTimeout: const Duration(seconds: 10),
                receiveTimeout: const Duration(seconds: 15),
                headers: <String, dynamic>{
                  'Accept': 'application/json',
                  'X-Device-Key': deviceKey.trim(),
                },
              ),
            );

  final String _hubUrl;
  final String _deviceKey;
  final Dio _dio;

  String get hubUrl => _hubUrl;
  String get deviceKey => _deviceKey;

  static String normalizeBaseUrl(String rawUrl) {
    final trimmed = rawUrl.trim();
    if (trimmed.endsWith('/')) {
      return trimmed.substring(0, trimmed.length - 1);
    }
    return trimmed;
  }

  /// Verifica el estado de salud del Hub (`GET /api/health`).
  Future<HubHealth> checkHealth() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/health',
        options: Options(headers: <String, dynamic>{'X-Device-Key': _deviceKey}),
      );
      final data = response.data;
      if (data == null) {
        throw const ApiException('Respuesta vacía desde /api/health.');
      }
      return HubHealth.fromJson(data);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  /// Obtiene la lista de calendarios disponibles en el Hub (`GET /api/calendars`).
  Future<List<CalendarInfo>> listCalendars() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/calendars',
        options: Options(headers: <String, dynamic>{'X-Device-Key': _deviceKey}),
      );
      final rawList = response.data?['calendars'];
      if (rawList is! List) {
        return const <CalendarInfo>[];
      }
      return rawList
          .whereType<Map<String, dynamic>>()
          .map(CalendarInfo.fromJson)
          .toList(growable: false);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  /// Obtiene las citas de un calendario en el rango indicado (`GET /api/calendars/:id/events`).
  Future<List<Event>> listEvents(
    String calendarId, {
    DateTime? from,
    DateTime? to,
  }) async {
    try {
      final encodedId = Uri.encodeComponent(calendarId);
      final queryParams = <String, dynamic>{
        if (from != null) 'from': from.toUtc().toIso8601String(),
        if (to != null) 'to': to.toUtc().toIso8601String(),
      };

      final response = await _dio.get<Map<String, dynamic>>(
        '/api/calendars/$encodedId/events',
        queryParameters: queryParams,
        options: Options(headers: <String, dynamic>{'X-Device-Key': _deviceKey}),
      );
      final rawList = response.data?['events'];
      if (rawList is! List) {
        return const <Event>[];
      }
      return rawList
          .whereType<Map<String, dynamic>>()
          .map(Event.fromJson)
          .toList(growable: false);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  /// Obtiene el estado actual libre/ocupada de una sala (`GET /api/rooms/:id/status`).
  Future<RoomStatus> getRoomStatus(String roomId) async {
    try {
      final encodedId = Uri.encodeComponent(roomId);
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/rooms/$encodedId/status',
        options: Options(headers: <String, dynamic>{'X-Device-Key': _deviceKey}),
      );
      final data = response.data;
      if (data == null) {
        throw const ApiException('Respuesta vacía al consultar estado de sala.');
      }
      return RoomStatus.fromJson(data);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  /// Realiza una reserva rápida de una sala (`POST /api/rooms/:id/book`).
  Future<Event> bookRoom(
    String roomId,
    int minutes, {
    String? subject,
  }) async {
    try {
      final encodedId = Uri.encodeComponent(roomId);
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/rooms/$encodedId/book',
        data: <String, dynamic>{
          'minutes': minutes,
          if (subject != null && subject.isNotEmpty) 'subject': subject,
        },
        options: Options(headers: <String, dynamic>{'X-Device-Key': _deviceKey}),
      );
      final data = response.data?['event'];
      if (data is! Map<String, dynamic>) {
        throw const ApiException('Respuesta inesperada al realizar reserva rápida.');
      }
      return Event.fromJson(data);
    } on DioException catch (error) {
      throw _mapDioError(error);
    }
  }

  ApiException _mapDioError(DioException error) {
    final statusCode = error.response?.statusCode;
    final data = error.response?.data;
    final serverMessage = data is Map<String, dynamic> ? data['message'] as String? : null;

    if (statusCode == 409) {
      return ApiException(
        serverMessage ?? 'La sala no está libre para el intervalo seleccionado.',
        statusCode: 409,
      );
    }
    if (statusCode == 401) {
      return ApiException(
        serverMessage ?? 'Clave de dispositivo (X-Device-Key) inválida o no autorizada.',
        statusCode: 401,
      );
    }
    if (statusCode == 429) {
      return ApiException(
        serverMessage ?? 'Demasiadas peticiones al Hub. Inténtalo de nuevo en unos segundos.',
        statusCode: 429,
      );
    }
    if (statusCode != null) {
      return ApiException(
        serverMessage ?? 'Error del Hub (HTTP $statusCode).',
        statusCode: statusCode,
      );
    }

    return ApiException(
      'No se pudo conectar con el Hub en $_hubUrl. Verifica la IP, el puerto y la red local.',
    );
  }
}

