# EPP Power Modes

[English](README.md) | [Deutsch](README.de.md) | [**Español**](README.es.md)

Una extensión de Ajustes rápidos para GNOME Shell (46+) con cuatro estados
fijos de preferencia de rendimiento energético (EPP) de la CPU:

| Modo                     | EPP                   | `platform_profile` |
|--------------------------|-----------------------|--------------------|
| Ahorro de energía        | `power`               | `low-power`        |
| Equilibrado-Ahorro       | `balance_power`       | `low-power`         |
| Equilibrado-Rendimiento  | `balance_performance` | `balanced`         |
| Rendimiento              | `performance`         | `performance`      |

`platform_profile` solo tiene tres niveles frente a los cuatro de EPP;
Equilibrado-Ahorro comparte el nivel `low-power` con Ahorro de energía en
vez de con Equilibrado-Rendimiento, porque en hardware ThinkPad DYTC es
`platform_profile` —no EPP— quien controla el ventilador. EPP sigue siendo
el ajuste más fino dentro de ese nivel compartido.

También incluye un interruptor **Bloquear** que impide cambios automáticos
causados por el firmware o las teclas ACPI sin afectar a la selección manual,
y una **protección de batería**. Esta fuerza como mínimo el modo
`Equilibrado-Ahorro` al bajar del 20 % durante la descarga, independientemente
del bloqueo. Un modo `Ahorro de energía` seleccionado manualmente permanece
activo. Al cambiar el bloqueo, el menú permanece abierto y la regla se guarda
inmediatamente. Si falla el siguiente intento de aplicación, el bloqueo vuelve
a desactivarse en lugar de indicar una protección que el hardware no pudo
mantener.

Sucesor de
[`power-saver-epp-fix`](https://github.com/shell-extensions/power-saver-epp-fix);
consulte [PLAN.md](PLAN.md) para ver la justificación completa del diseño.

![Menú de Ajustes rápidos de EPP Power Modes](image/eppmode-quick-settings.png)

## Estado del hardware

El mosaico lee directamente de sysfs el valor EPP de cada CPU disponible. Se
actualiza después de los cambios propios, al abrir el menú y cada cinco
segundos. De esta forma, los cambios EPP externos son visibles incluso con el
bloqueo desactivado. Los cuatro valores exactos se asignan directamente a los
cuatro modos de la tabla. Los valores de CPU divergentes se muestran como
**Mixto** y los valores EPP ilegibles o no compatibles como **Desconocido**.
Cuando existe `platform_profile`, el ayudante verifica que EPP y el perfil de
plataforma permanezcan coherentes. Con el bloqueo activado, revierte cualquier
desviación. Con el bloqueo desactivado, adopta los cambios externos:
`balanced` se convierte en `Equilibrado-Rendimiento`; `low-power` se
convierte en `Ahorro de energía`, salvo que las CPU ya indiquen
`balance_power`, en cuyo caso se convierte en `Equilibrado-Ahorro`.
En kernels recientes, las interfaces específicas de cada proveedor bajo
`/sys/class/platform-profile/` son la fuente autoritativa para la lectura y la
verificación. Para escribir, el ayudante prefiere la interfaz agregada antigua
`/sys/firmware/acpi/platform_profile` como vía coordinada por el kernel y solo
recurre a la escritura directa del proveedor cuando esa interfaz no está
disponible o rechaza la solicitud. En cierto firmware DYTC de ThinkPad, una
escritura de `platform_profile` puede rechazarse silenciosamente,
independientemente del estado de red/batería o de la proximidad a las
escrituras previas de EPP/PPD (véase
[`docs/power-saver-platform-profile-diagnose.de.md`](docs/power-saver-platform-profile-diagnose.de.md)
para la medición detrás de esto). En vez de hacer fallar todo el cambio de
modo por eso, el ayudante trata un perfil de plataforma no confirmado como
pendiente: EPP y `power-profiles-daemon` siguen vigentes, el icono sigue
mostrando el modo seleccionado, en el menú aparece «Perfil de plataforma
pendiente», y el reassert en segundo plano sigue reintentando (limitado para
no saturar el firmware) hasta que el hardware lo confirme.

El instalador mantiene activo `power-profiles-daemon`, pero lo reinicia con su
controlador `platform_profile` bloqueado mediante la protección ya probada en
`power-saver-epp-fix`. El ayudante selecciona primero el perfil general
correspondiente de PPD, espera a que termine su escritura de CPU y después
aplica y verifica el estado EPP y de plataforma exacto de la tabla. La
desinstalación elimina la protección y reinicia PPD normalmente.

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
