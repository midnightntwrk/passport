(module
  (type (;0;) (func (param i32 i64 i64) (result i64)))
  (type (;1;) (func (param i64) (result i64)))
  (type (;2;) (func (param i64 i64) (result i64)))
  (type (;3;) (func))
  (func (;0;) (type 0) (param i32 i64 i64) (result i64)
    (local i32 i64 i64 i64 i32 i64 i64 i32 i64)
    local.get 0
    local.get 1
    local.get 2
    local.set 5
    local.set 4
    local.set 3
    block  ;; label = @1
      block  ;; label = @2
        local.get 3
        i32.const 2
        i32.ne
        br_if 0 (;@2;)
        local.get 4
        i32.wrap_i64
        local.set 7
        local.get 5
        local.set 8
        block  ;; label = @3
          local.get 7
          i32.const 0
          i32.ne
          br_if 0 (;@3;)
          local.get 8
          local.set 9
          local.get 9
          local.set 6
          br 2 (;@1;)
        end
        i64.const 2
        local.set 6
        br 1 (;@1;)
      end
      block  ;; label = @2
        local.get 3
        i32.const 0
        i32.ne
        br_if 0 (;@2;)
        local.get 4
        i32.wrap_i64
        local.set 10
        i64.const 0
        local.set 6
        br 1 (;@1;)
      end
      block  ;; label = @2
        local.get 3
        i32.const 1
        i32.ne
        br_if 0 (;@2;)
        local.get 4
        local.set 11
        local.get 11
        local.set 6
        br 1 (;@1;)
      end
      unreachable
    end
    local.get 6)
  (func (;1;) (type 0) (param i32 i64 i64) (result i64)
    (local i32 i64 i64 i64 i32)
    local.get 0
    local.get 1
    local.get 2
    local.set 5
    local.set 4
    local.set 3
    block  ;; label = @1
      block  ;; label = @2
        local.get 3
        i32.const 0
        i32.ne
        br_if 0 (;@2;)
        local.get 4
        i32.wrap_i64
        local.set 7
        i64.const 1
        local.set 6
        br 1 (;@1;)
      end
      i64.const 0
      local.set 6
      br 0 (;@1;)
    end
    local.get 6)
  (func (;2;) (type 1) (param i64) (result i64)
    (local i64 i64)
    local.get 0
    local.set 1
    block  ;; label = @1
      block  ;; label = @2
        local.get 1
        i64.const 42
        i64.ne
        br_if 0 (;@2;)
        i64.const 1
        local.set 2
        br 1 (;@1;)
      end
      i64.const 0
      local.set 2
      br 0 (;@1;)
    end
    local.get 2)
  (func (;3;) (type 2) (param i64 i64) (result i64)
    (local i64)
    local.get 0
    local.get 1
    i64.add
    local.tee 2
    local.get 0
    local.get 1
    i64.xor
    i64.const 0
    i64.ge_s
    local.get 2
    local.get 0
    i64.xor
    i64.const 0
    i64.lt_s
    i32.and
    i32.const 0
    i32.ne
    if  ;; label = @1
      unreachable
    end)
  (func (;4;) (type 0) (param i32 i64 i64) (result i64)
    (local i32 i64 i64 i64 i64 i64)
    local.get 0
    local.get 1
    local.get 2
    local.set 5
    local.set 4
    local.set 3
    block  ;; label = @1
      block  ;; label = @2
        local.get 3
        i32.const 1
        i32.ne
        br_if 0 (;@2;)
        local.get 4
        local.set 7
        local.get 5
        local.set 8
        local.get 7
        local.get 8
        call 3
        local.set 6
        br 1 (;@1;)
      end
      i64.const 0
      local.set 6
      br 0 (;@1;)
    end
    local.get 6)
  (func (;5;) (type 3)
    (local i64)
    i32.const 0
    i32.const 1
    i64.extend_i32_u
    local.set 0
    local.get 0
    i64.const 0
    call 0
    drop)
  (export "get-bar" (func 5)))
