#pragma once
#include <stddef.h>
#include <stdint.h>

/* The camera retains the frozen JPEG until stop. Reads may be repeated for
 * digest calculation and selective retransmission without buffering a JPEG. */
int vc0706_camera_begin(uint16_t width, uint16_t height, uint32_t *length);
int vc0706_camera_read(uint32_t offset, uint8_t *data, size_t length);
void vc0706_camera_stop(void);
