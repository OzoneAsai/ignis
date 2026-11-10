<script>
  import { createEventDispatcher } from "svelte";

  export let primary = "";
  export let secondary = "";
  export let active = false;
  export let clickable = true;

  const dispatch = createEventDispatcher();

  function onClick() {
    if (clickable) {
      dispatch("click");
    }
  }
</script>

<div class="list-item" class:active class:clickable>
  {#if clickable}
    <button type="button" class="item-main" aria-current={active ? "true" : undefined} on:click={onClick}>
      {#if $$slots.icon}
        <div class="item-icon">
          <slot name="icon" />
        </div>
      {/if}

      <div class="item-content">
        {#if $$slots.default}
          <slot />
        {:else}
          <span class="item-primary">{primary}</span>
          {#if secondary}
            <span class="item-secondary">{secondary}</span>
          {/if}
        {/if}
      </div>
    </button>
  {:else}
    <div class="item-main">
      {#if $$slots.icon}
        <div class="item-icon">
          <slot name="icon" />
        </div>
      {/if}

      <div class="item-content">
        {#if $$slots.default}
          <slot />
        {:else}
          <span class="item-primary">{primary}</span>
          {#if secondary}
            <span class="item-secondary">{secondary}</span>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  {#if $$slots.action}
    <div class="item-action">
      <slot name="action" />
    </div>
  {/if}
</div>

<style>
  .list-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0.4rem 0.5rem 1rem;
    margin: 0 0.2rem;
    background: var(--background-primary);
    border-radius: 0.5rem;
    border: 1px solid transparent;
    transition:
      background 0.1s,
      border-color 0.1s;
  }

  .list-item.clickable {
    cursor: pointer;
  }

  .list-item.clickable:hover {
    background: var(--background-modifier-hover);
    border-color: var(--background-modifier-border);
  }
  .item-main {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex: 1;
    min-width: 0;
  }
  button.item-main {
    appearance: none;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-align: left;
  }
  button.item-main:focus-visible {
    outline: 2px solid var(--interactive-accent);
    outline-offset: 3px;
    border-radius: 0.25rem;
  }

  .item-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-muted);
    opacity: 0.6;
  }

  .item-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .item-primary {
    font-weight: 600;
    font-size: 1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-secondary {
    font-size: 0.8125rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-action {
    flex-shrink: 0;
    margin-left: auto;
  }
</style>
