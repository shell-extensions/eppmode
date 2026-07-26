# EPP Power Modes

[English](README.md) | [Deutsch](README.de.md) | [**Español**](README.es.md)

Una extensión de Ajustes rápidos para GNOME Shell (46+) con cuatro estados
fijos de preferencia de rendimiento energético (EPP) de la CPU, que evita por
completo `power-profiles-daemon`:

| Modo                     | EPP                   | `platform_profile` |
|--------------------------|-----------------------|--------------------|
| Ahorro de energía        | `power`               | `low-power`        |
| Equilibrado-Ahorro       | `balance_power`       | `balanced`         |
| Equilibrado-Rendimiento  | `balance_performance` | `balanced`         |
| Rendimiento              | `performance`         | `performance`      |

También incluye un interruptor **Bloquear** que impide cambios automáticos
causados por el firmware o las teclas ACPI sin afectar a la selección manual,
y una **protección de batería**. Esta fuerza el modo `Equilibrado-Ahorro` al
bajar del 20 % durante la descarga, independientemente del bloqueo.

Sucesor de
[`power-saver-epp-fix`](https://github.com/shell-extensions/power-saver-epp-fix);
consulte [PLAN.md](PLAN.md) para ver la justificación completa del diseño.

![Menú de Ajustes rápidos de EPP Power Modes](image/eppmode-quick-settings.png)

## Instalación

```sh
bash install.sh
```

Instala un ayudante con privilegios de root en
`/usr/local/bin/eppmode-helper`, una regla sudoers sin contraseña limitada a
ese único binario (`/etc/sudoers.d/eppmode`) y unidades systemd para restaurar
el estado al arrancar, volver a aplicar el bloqueo y comprobar periódicamente
la protección de batería. Requiere `sudo`.

## Desinstalación

```sh
bash uninstall.sh
```

Elimina el ayudante, la regla sudoers, las unidades systemd, la regla udev y el
directorio de estado. La extensión de GNOME Shell debe eliminarse por
separado, por ejemplo:

```sh
gnome-extensions uninstall eppmode@yurij.de
```

## Traducciones

Inglés (idioma fuente), alemán y español. Después de modificar `extension.js`
o un archivo `.po`, puede regenerar `po/eppmode.pot` y compilar los archivos
`.mo` con:

```sh
tools/build-locale.sh
```

## Licencia

GPL-3.0-or-later, consulte `LICENSE`.
