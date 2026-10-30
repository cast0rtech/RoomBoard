/// Estado de disponibilidad del evento según Microsoft Graph (`showAs`).
enum ShowAsStatus {
  free,
  tentative,
  busy,
  oof,
  workingElsewhere,
  unknown;

  factory ShowAsStatus.fromJson(String? raw) {
    switch (raw) {
      case 'free':
        return ShowAsStatus.free;
      case 'tentative':
        return ShowAsStatus.tentative;
      case 'busy':
        return ShowAsStatus.busy;
      case 'oof':
        return ShowAsStatus.oof;
      case 'workingElsewhere':
        return ShowAsStatus.workingElsewhere;
      default:
        return ShowAsStatus.unknown;
    }
  }
}

/// Estado libre/ocupada de una sala expuesto por el Hub.
enum RoomState {
  free,
  busy;

  factory RoomState.fromJson(String? raw) {
    return raw == 'busy' ? RoomState.busy : RoomState.free;
  }

  String toJson() => name;
}

/// Modelo de evento de calendario recibido desde el Hub.
class Event {
  const Event({
    required this.id,
    required this.subject,
    required this.start,
    required this.end,
    this.organizer,
    this.isAllDay = false,
    this.isCancelled = false,
    this.showAs = ShowAsStatus.busy,
    this.location,
  });

  factory Event.fromJson(Map<String, dynamic> json) {
    return Event(
      id: (json['id'] as String?) ?? '',
      subject: (json['subject'] as String?) ?? 'Ocupado',
      start: DateTime.parse(json['start'] as String),
      end: DateTime.parse(json['end'] as String),
      organizer: json['organizer'] as String?,
      isAllDay: (json['isAllDay'] as bool?) ?? false,
      isCancelled: (json['isCancelled'] as bool?) ?? false,
      showAs: ShowAsStatus.fromJson(json['showAs'] as String?),
      location: json['location'] as String?,
    );
  }

  final String id;
  final String subject;
  final DateTime start;
  final DateTime end;
  final String? organizer;
  final bool isAllDay;
  final bool isCancelled;
  final ShowAsStatus showAs;
  final String? location;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'subject': subject,
        'start': start.toIso8601String(),
        'end': end.toIso8601String(),
        'organizer': organizer,
        'isAllDay': isAllDay,
        'isCancelled': isCancelled,
        'showAs': showAs.name,
        'location': location,
      };
}

/// Alias mantenido por compatibilidad.
typedef CalendarEventModel = Event;

/// Información de un calendario o buzón de sala disponible en el Hub.
class CalendarInfo {
  const CalendarInfo({
    required this.id,
    required this.name,
    this.ownerAddress,
    this.mailbox,
  });

  factory CalendarInfo.fromJson(Map<String, dynamic> json) {
    return CalendarInfo(
      id: (json['id'] as String?) ?? '',
      name: (json['name'] as String?) ?? 'Calendario',
      ownerAddress: json['ownerAddress'] as String?,
      mailbox: json['mailbox'] as String?,
    );
  }

  final String id;
  final String name;
  final String? ownerAddress;
  final String? mailbox;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        if (ownerAddress != null) 'ownerAddress': ownerAddress,
        if (mailbox != null) 'mailbox': mailbox,
      };
}

/// Estado en tiempo real de una sala calculado por el Hub.
class RoomStatus {
  const RoomStatus({
    required this.state,
    this.current,
    this.next,
    this.until,
  });

  factory RoomStatus.fromJson(Map<String, dynamic> json) {
    final currentRaw = json['current'];
    final nextRaw = json['next'];
    final untilRaw = json['until'] as String?;

    return RoomStatus(
      state: RoomState.fromJson(json['state'] as String?),
      current: currentRaw is Map<String, dynamic> ? Event.fromJson(currentRaw) : null,
      next: nextRaw is Map<String, dynamic> ? Event.fromJson(nextRaw) : null,
      until: untilRaw != null && untilRaw.isNotEmpty ? DateTime.tryParse(untilRaw) : null,
    );
  }

  final RoomState state;
  final Event? current;
  final Event? next;
  final DateTime? until;

  bool get isBusy => state == RoomState.busy;
  bool get isFree => state == RoomState.free;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'state': state.toJson(),
        'current': current?.toJson(),
        'next': next?.toJson(),
        'until': until?.toIso8601String(),
      };
}

/// Estado de salud del servicio Hub (`GET /api/health`).
class HubHealth {
  const HubHealth({
    required this.status,
    required this.service,
    this.authMode,
    this.timezone,
    this.cachedCalendars = 0,
    this.timestamp,
  });

  factory HubHealth.fromJson(Map<String, dynamic> json) {
    final ts = json['timestamp'] as String?;
    return HubHealth(
      status: (json['status'] as String?) ?? 'unknown',
      service: (json['service'] as String?) ?? 'roomboard-hub',
      authMode: json['authMode'] as String?,
      timezone: json['timezone'] as String?,
      cachedCalendars: (json['cachedCalendars'] as num?)?.toInt() ?? 0,
      timestamp: ts != null ? DateTime.tryParse(ts) : null,
    );
  }

  final String status;
  final String service;
  final String? authMode;
  final String? timezone;
  final int cachedCalendars;
  final DateTime? timestamp;

  bool get isOk => status == 'ok';
}
