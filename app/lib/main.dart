import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/core.dart';
import 'features/room_display/room_display_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    const ProviderScope(
      child: RoomBoardApp(),
    ),
  );
}

class RoomBoardApp extends ConsumerWidget {
  const RoomBoardApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settingsAsync = ref.watch(connectionSettingsProvider);
    final themeMode = ref.watch(themeModeProvider);

    return MaterialApp(
      title: 'RoomBoard',
      debugShowCheckedModeBanner: false,
      themeMode: themeMode,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.teal,
          brightness: Brightness.light,
        ),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.teal,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: settingsAsync.when(
        data: (settings) {
          if (!settings.hasCredentials) {
            return const SettingsScreen();
          }
          // Al iniciar con configuración guardada, abre directamente la pantalla de sala
          return const RoomDisplayScreen();
        },
        loading: () => const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
        error: (_, __) => const SettingsScreen(),
      ),
    );
  }
}
